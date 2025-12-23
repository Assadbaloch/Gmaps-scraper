// ============================================================================
// IMPORTS
// ============================================================================

import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

// ============================================================================
// CONSTANTS
// ============================================================================

const GOOGLE_MAPS_URL = 'https://www.google.com/maps/search/';
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const SCROLL_DELAY = 2000;
const MAX_SCROLL_ATTEMPTS = 100;
const REQUEST_TIMEOUT = 180000;
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
        
        await page.waitForTimeout(2000);
        
        const content = await page.content();
        const emails = content.match(EMAIL_REGEX);
        
        if (emails && emails.length > 0) {
            // Filter out common non-email matches and get unique emails
            const validEmails = [...new Set(emails)]
                .filter(email => !email.includes('.png') && !email.includes('.jpg'));
            
            if (validEmails.length > 0) {
                log.info(`Found email: ${validEmails[0]}`);
                return validEmails[0];
            }
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
 * Click on a place card and extract detailed information from the side panel
 */
async function extractDetailedPlaceInfo(page, card, log) {
    try {
        // Get business name from the card first
        const businessName = await card.$eval('a[aria-label]', (el) => {
            return el.getAttribute('aria-label') || el.textContent.trim();
        }).catch(() => null);

        if (!businessName) {
            return null;
        }

        log.info(`Clicking on: ${businessName}`);

        // Click on the place card to open details panel
        await card.click();
        await page.waitForTimeout(3000); // Wait for details to load

        // Extract all information from the details panel
        const placeData = await page.evaluate(() => {
            const data = {
                business_name: null,
                category: null,
                address: null,
                phone: null,
                website: null,
                rating: null,
                reviews_count: null,
                email: null,
                hours: null,
                plus_code: null
            };

            // Business name from header
            const nameElement = document.querySelector('h1[class*="fontHeadlineLarge"]');
            if (nameElement) {
                data.business_name = nameElement.textContent.trim();
            }

            // Category
            const categoryButton = document.querySelector('button[jsaction*="category"]');
            if (categoryButton) {
                data.category = categoryButton.textContent.trim();
            }

            // Rating and reviews
            const ratingElement = document.querySelector('div[jsaction*="pane.rating"]');
            if (ratingElement) {
                const ratingText = ratingElement.textContent;
                const ratingMatch = ratingText.match(/(\d+\.?\d*)/);
                if (ratingMatch) {
                    data.rating = parseFloat(ratingMatch[1]);
                }
                const reviewsMatch = ratingText.match(/\((\d+(?:,\d+)*)\)/);
                if (reviewsMatch) {
                    data.reviews_count = parseInt(reviewsMatch[1].replace(/,/g, ''));
                }
            }

            // Get all buttons in the action bar (phone, website, etc.)
            const buttons = document.querySelectorAll('button[data-item-id]');
            buttons.forEach(button => {
                const ariaLabel = button.getAttribute('aria-label') || '';
                
                // Website
                if (ariaLabel.toLowerCase().includes('website')) {
                    const link = button.querySelector('a');
                    if (link) {
                        const href = link.getAttribute('href');
                        if (href && href.includes('/url?q=')) {
                            try {
                                const urlParams = new URLSearchParams(href.split('?')[1]);
                                data.website = urlParams.get('q');
                            } catch (e) {
                                data.website = href;
                            }
                        } else if (href) {
                            data.website = href;
                        }
                    }
                }
                
                // Phone
                if (ariaLabel.toLowerCase().includes('phone') || ariaLabel.toLowerCase().includes('call')) {
                    const phoneMatch = ariaLabel.match(/[\+\d][\d\s\-\(\)]+/);
                    if (phoneMatch) {
                        data.phone = phoneMatch[0].trim();
                    }
                }
            });

            // Address and other info from the info section
            const infoElements = document.querySelectorAll('button[data-item-id^="address"]');
            infoElements.forEach(elem => {
                const text = elem.textContent.trim();
                const ariaLabel = elem.getAttribute('aria-label') || '';
                
                if (ariaLabel.toLowerCase().includes('address') || text.match(/\d+.*(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive)/i)) {
                    data.address = text;
                }
            });

            // Try alternative address selector
            if (!data.address) {
                const addressDiv = document.querySelector('[data-item-id="address"]');
                if (addressDiv) {
                    data.address = addressDiv.textContent.trim();
                }
            }

            // Plus code
            const plusCodeButton = document.querySelector('button[data-item-id="oloc"]');
            if (plusCodeButton) {
                data.plus_code = plusCodeButton.textContent.trim();
            }

            // Check if permanently closed
            const closedText = document.body.textContent;
            data.isClosed = closedText.includes('Permanently closed') || closedText.includes('Closed permanently');

            // Try to find email in the visible content (some businesses show it)
            const emailMatch = document.body.textContent.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
            if (emailMatch) {
                data.email = emailMatch[0];
            }

            return data;
        });

        log.info(`Extracted: ${placeData.business_name} | Phone: ${placeData.phone || 'N/A'} | Website: ${placeData.website || 'N/A'}`);

        return placeData;

    } catch (error) {
        log.warning(`Failed to extract detailed info: ${error.message}`);
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
                let processedCardIndices = new Set();

                log.info('Starting to extract all available places...');

                while (scrollAttempts < MAX_SCROLL_ATTEMPTS) {
                    const reachedEnd = await isEndOfResults(page, log);
                    if (reachedEnd) {
                        log.info('Reached end of results');
                        break;
                    }

                    const cards = await page.$$('div[role="feed"] > div > div[jsaction]');
                    log.info(`Found ${cards.length} result cards (scroll attempt ${scrollAttempts + 1})`);

                    let newPlacesThisScroll = 0;

                    // Process cards we haven't seen yet
                    for (let i = 0; i < cards.length; i++) {
                        if (processedCardIndices.has(i)) {
                            continue;
                        }

                        const card = cards[i];
                        processedCardIndices.add(i);

                        // Extract detailed info by clicking on the card
                        const placeData = await extractDetailedPlaceInfo(page, card, log);
                        
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

                        // Extract email from website if available and no email found yet
                        if (placeData.website && !placeData.email) {
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

                        log.info(`✅ Extracted #${totalExtracted}: ${placeData.business_name}`);
                        log.info(`   📞 ${placeData.phone || 'No phone'} | 🌐 ${placeData.website ? 'Has website' : 'No website'} | ⭐ ${placeData.rating || 'N/A'}`);
                    }

                    if (newPlacesThisScroll === 0) {
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
