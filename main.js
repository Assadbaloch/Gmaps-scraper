// ============================================================================
// IMPORTS
// ============================================================================

import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

// ============================================================================
// CONSTANTS
// ============================================================================

const GOOGLE_MAPS_URL = 'https://www.google.com/maps/search/';
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const SCROLL_DELAY = 2000;
const MAX_SCROLL_ATTEMPTS = 100;
const REQUEST_TIMEOUT = 120000;
const NO_NEW_RESULTS_THRESHOLD = 5;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Generate unique key for deduplication
 */
function generatePlaceKey(businessName, address) {
    const normalize = (str) => str.toLowerCase().trim().replace(/\s+/g, ' ');
    return `${normalize(businessName)}|${normalize(address)}`;
}

/**
 * Extract email from website homepage
 */
async function extractEmailFromWebsite(page, url, log) {
    try {
        log.info(`Fetching website for email: ${url}`);
        
        await page.goto(url, { 
            waitUntil: 'domcontentloaded',
            timeout: 15000 
        });
        
        const content = await page.content();
        const emailMatch = content.match(EMAIL_REGEX);
        
        if (emailMatch) {
            log.info(`Found email: ${emailMatch[0]}`);
            return emailMatch[0];
        }
        
        log.info('No email found on homepage');
        return null;
    } catch (error) {
        log.warning(`Failed to extract email from ${url}: ${error.message}`);
        return null;
    }
}

/**
 * Scroll the results panel to load more places
 */
async function scrollResultsPanel(page, log) {
    try {
        const scrollableDiv = await page.$('div[role="feed"]');
        
        if (!scrollableDiv) {
            log.warning('Could not find scrollable results panel');
            return false;
        }

        const previousHeight = await scrollableDiv.evaluate((el) => el.scrollHeight);

        await scrollableDiv.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
        });

        await page.waitForTimeout(SCROLL_DELAY);
        
        const newHeight = await scrollableDiv.evaluate((el) => el.scrollHeight);
        
        return newHeight > previousHeight;
    } catch (error) {
        log.warning(`Scroll failed: ${error.message}`);
        return false;
    }
}

/**
 * Extract place details from a result card - IMPROVED VERSION
 */
async function extractPlaceDetails(card, log) {
    try {
        // Extract business name
        const businessName = await card.$eval('a[aria-label]', (el) => {
            const ariaLabel = el.getAttribute('aria-label');
            return ariaLabel || el.textContent.trim();
        }).catch(() => null);

        if (!businessName) {
            return null;
        }

        // Extract rating
        const rating = await card.$eval('span[role="img"]', (el) => {
            const ariaLabel = el.getAttribute('aria-label');
            const match = ariaLabel?.match(/(\d+\.?\d*)\s+stars?/i);
            return match ? parseFloat(match[1]) : null;
        }).catch(() => null);

        // IMPROVED: Extract all information including website
        const details = await card.evaluate((cardElement) => {
            let address = null;
            let phone = null;
            let website = null;

            // Get all text content
            const allText = cardElement.textContent;

            // Find all links in the card
            const links = cardElement.querySelectorAll('a');
            
            // Look for website link - improved detection
            for (const link of links) {
                const href = link.getAttribute('href');
                const ariaLabel = link.getAttribute('aria-label');
                
                // Check if it's a website link (not Google links)
                if (href && (
                    (href.startsWith('http') && !href.includes('google.com')) ||
                    (ariaLabel && ariaLabel.toLowerCase().includes('website'))
                )) {
                    // If it's a Google redirect, extract the actual URL
                    if (href.includes('/url?q=')) {
                        try {
                            const urlParams = new URLSearchParams(href.split('?')[1]);
                            website = urlParams.get('q') || href;
                        } catch (e) {
                            website = href;
                        }
                    } else {
                        website = href;
                    }
                    break;
                }
            }

            // Extract address - look for text with street patterns
            const divs = cardElement.querySelectorAll('div');
            for (const div of divs) {
                const text = div.textContent.trim();
                
                // Address detection
                if (!address && (
                    text.match(/\d+.*(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Lane|Way|Court|Place|Circle|Plaza|Parkway)/i) ||
                    text.match(/^\d+\s+[A-Za-z]/) ||
                    text.match(/,\s*[A-Z]{2}\s+\d{5}/)
                )) {
                    address = text;
                }
                
                // Phone detection - improved pattern
                if (!phone && text.match(/^[\+]?[(]?\d{1,3}[)]?[-\s\.]?\d{1,4}[-\s\.]?\d{1,4}[-\s\.]?\d{1,9}$/)) {
                    phone = text;
                }
            }

            return { address, phone, website };
        });

        // Check if permanently closed
        const isClosed = await card.evaluate((el) => {
            const text = el.textContent.toLowerCase();
            return text.includes('permanently closed') || text.includes('closed permanently');
        }).catch(() => false);

        return {
            business_name: businessName,
            address: details.address,
            phone: details.phone,
            website: details.website,
            rating: rating,
            email: null,
            isClosed: isClosed
        };
    } catch (error) {
        log.warning(`Failed to extract place details: ${error.message}`);
        return null;
    }
}

/**
 * Wait for results to load
 */
async function waitForResults(page, log) {
    try {
        await page.waitForSelector('div[role="feed"]', { timeout: 15000 });
        await page.waitForTimeout(3000);
        return true;
    } catch (error) {
        log.error('Results panel did not load');
        return false;
    }
}

/**
 * Check if we've reached the end of results
 */
async function isEndOfResults(page, log) {
    try {
        const endText = await page.evaluate(() => {
            const body = document.body.textContent;
            return body.includes("You've reached the end of the list") || 
                   body.includes("You've reached the end");
        });
        
        if (endText) {
            log.info('Reached end of results');
            return true;
        }
        return false;
    } catch (error) {
        return false;
    }
}

// ============================================================================
// MAIN ACTOR LOGIC
// ============================================================================

await Actor.init();

try {
    const input = await Actor.getInput();
    
    if (!input) {
        throw new Error('Input is required');
    }

    const {
        queries = [],
        language = 'en',
        skipClosedPlaces = true,
        minRating = null,
        requireWebsite = false
    } = input;

    if (!queries || queries.length === 0) {
        throw new Error('queries array is required and must not be empty');
    }

    // Validate each query
    for (const query of queries) {
        if (!query.searchTerm || query.searchTerm.trim() === '') {
            throw new Error('Each query must have a searchTerm');
        }
        if (!query.location || query.location.trim() === '') {
            throw new Error('Each query must have a location');
        }
    }

    console.log('Actor Input:', {
        totalQueries: queries.length,
        language,
        skipClosedPlaces,
        minRating,
        requireWebsite
    });

    console.log('Queries to process:', queries);

    const seenPlaces = new Set();
    let totalExtracted = 0;

    for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
        const query = queries[queryIndex];
        const { searchTerm, location } = query;

        console.log(`\n${'='.repeat(80)}`);
        console.log(`Processing Query ${queryIndex + 1}/${queries.length}`);
        console.log(`Search: "${searchTerm}" | Location: "${location}"`);
        console.log(`${'='.repeat(80)}\n`);

        const crawler = new PlaywrightCrawler({
            launchContext: {
                launchOptions: {
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
                }
            },
            requestHandlerTimeoutSecs: REQUEST_TIMEOUT / 1000,
            maxRequestRetries: 3,
            
            async requestHandler({ page, request, log }) {
                log.info(`Loading Google Maps for: "${searchTerm}" in "${location}"`);

                const resultsLoaded = await waitForResults(page, log);
                if (!resultsLoaded) {
                    log.error('Failed to load results, skipping this query');
                    return;
                }

                let placesExtractedThisQuery = 0;
                let scrollAttempts = 0;
                let noNewResultsCount = 0;
                let previousCardCount = 0;

                log.info('Starting to extract all available places...');

                while (scrollAttempts < MAX_SCROLL_ATTEMPTS) {
                    const reachedEnd = await isEndOfResults(page, log);
                    if (reachedEnd) {
                        log.info('Reached end of results');
                        break;
                    }

                    const cards = await page.$$('div[role="feed"] > div > div[jsaction]');
                    log.info(`Found ${cards.length} result cards (scroll attempt ${scrollAttempts + 1})`);

                    const newCards = cards.slice(previousCardCount);
                    let newPlacesThisScroll = 0;

                    for (const card of newCards) {
                        const placeData = await extractPlaceDetails(card, log);
                        
                        if (!placeData || !placeData.business_name) {
                            continue;
                        }

                        // Apply filters
                        if (skipClosedPlaces && placeData.isClosed) {
                            log.info(`❌ Skipping closed: ${placeData.business_name}`);
                            continue;
                        }

                        if (requireWebsite && !placeData.website) {
                            log.info(`❌ Skipping (no website): ${placeData.business_name}`);
                            continue;
                        }

                        if (minRating !== null && (placeData.rating === null || placeData.rating < minRating)) {
                            log.info(`❌ Skipping (low rating ${placeData.rating}): ${placeData.business_name}`);
                            continue;
                        }

                        // Deduplication
                        const placeKey = generatePlaceKey(
                            placeData.business_name, 
                            placeData.address || ''
                        );

                        if (seenPlaces.has(placeKey)) {
                            log.info(`⚠️ Duplicate: ${placeData.business_name}`);
                            continue;
                        }

                        seenPlaces.add(placeKey);

                        // Extract email from website
                        if (placeData.website) {
                            const emailPage = await page.context().newPage();
                            try {
                                placeData.email = await extractEmailFromWebsite(
                                    emailPage, 
                                    placeData.website, 
                                    log
                                );
                            } finally {
                                await emailPage.close();
                            }
                        }

                        delete placeData.isClosed;

                        // Add query metadata
                        placeData.query_searchTerm = searchTerm;
                        placeData.query_location = location;
                        placeData.query_index = queryIndex + 1;

                        await Dataset.pushData(placeData);
                        
                        placesExtractedThisQuery++;
                        totalExtracted++;
                        newPlacesThisScroll++;

                        log.info(`✅ Extracted #${totalExtracted}: ${placeData.business_name} ${placeData.website ? '(has website)' : '(no website)'}`);
                    }

                    previousCardCount = cards.length;

                    if (newPlacesThisScroll === 0 && newCards.length === 0) {
                        noNewResultsCount++;
                        log.info(`No new results (${noNewResultsCount}/${NO_NEW_RESULTS_THRESHOLD})`);
                        
                        if (noNewResultsCount >= NO_NEW_RESULTS_THRESHOLD) {
                            log.info('No new results after multiple scroll attempts, moving to next query');
                            break;
                        }
                    } else {
                        noNewResultsCount = 0;
                    }

                    const scrolled = await scrollResultsPanel(page, log);
                    scrollAttempts++;

                    if (!scrolled) {
                        log.info('Cannot scroll further, checking for more results...');
                        await page.waitForTimeout(2000);
                    }
                }

                log.info(`\n📊 Completed Query ${queryIndex + 1}/${queries.length}:`);
                log.info(`  - Search: "${searchTerm}"`);
                log.info(`  - Location: "${location}"`);
                log.info(`  - Places extracted: ${placesExtractedThisQuery}`);
                log.info(`  - Total dataset size: ${totalExtracted}\n`);
            },

            failedRequestHandler({ request, log }) {
                log.error(`Request failed for query: ${request.url}`);
            }
        });

        const searchQuery = `${searchTerm} ${location}`;
        const url = `${GOOGLE_MAPS_URL}${encodeURIComponent(searchQuery)}?hl=${language}`;
        
        const requests = [{
            url,
            userData: { searchTerm, location, queryIndex }
        }];

        await crawler.run(requests);

        console.log(`Completed processing query ${queryIndex + 1}/${queries.length}`);
    }

    console.log('\n' + '='.repeat(80));
    console.log('🎉 ACTOR COMPLETED SUCCESSFULLY');
    console.log('='.repeat(80));
    console.log(`Total queries processed: ${queries.length}`);
    console.log(`Total unique places extracted: ${totalExtracted}`);
    console.log(`Places in dataset: ${seenPlaces.size}`);
    console.log('='.repeat(80) + '\n');

} catch (error) {
    console.error('❌ Actor failed with error:', error);
    throw error;
}

await Actor.exit();
