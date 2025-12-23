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
async function extractEmailFromWebsite(url, log) {
    try {
        log.info(`Fetching website for email: ${url}`);
        
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            signal: AbortSignal.timeout(15000)
        });
        
        if (!response.ok) {
            log.warning(`HTTP ${response.status} when fetching ${url}`);
            return null;
        }
        
        const content = await response.text();
        const emails = content.match(EMAIL_REGEX);
        
        if (emails && emails.length > 0) {
            const validEmails = [...new Set(emails)]
                .filter(email => 
                    !email.includes('.png') && 
                    !email.includes('.jpg') &&
                    !email.includes('.jpeg') &&
                    !email.includes('.gif') &&
                    !email.includes('example.com') &&
                    !email.includes('sentry.io')
                );
            
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
 * Extract place URLs from the search results list
 */
async function extractPlaceUrls(page, log) {
    try {
        const urls = await page.$$eval('div[role="feed"] a[href*="/maps/place/"]', (links) => {
            return [...new Set(links.map(link => link.href))];
        });
        
        log.info(`Extracted ${urls.length} place URLs`);
        return urls;
    } catch (error) {
        log.warning(`Failed to extract place URLs: ${error.message}`);
        return [];
    }
}

/**
 * Extract detailed information from a place's individual page
 */
async function extractPlaceDetailsFromPage(page, log) {
    try {
        // Wait for the place details to load
        await page.waitForSelector('h1', { timeout: 10000 });
        await page.waitForTimeout(2000);

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
                plus_code: null,
                price_level: null,
                isClosed: false
            };

            // Business name
            const nameElement = document.querySelector('h1[class*="fontHeadlineLarge"]') || 
                               document.querySelector('h1');
            if (nameElement) {
                data.business_name = nameElement.textContent.trim();
            }

            // Category (secondary text under name)
            const categoryElement = document.querySelector('button[jsaction*="category"]');
            if (categoryElement) {
                data.category = categoryElement.textContent.trim();
            }

            // Rating and reviews
            const ratingDiv = document.querySelector('div[jsaction*="pane.rating"]');
            if (ratingDiv) {
                const ratingText = ratingDiv.textContent;
                const ratingMatch = ratingText.match(/(\d+\.?\d*)/);
                if (ratingMatch) {
                    data.rating = parseFloat(ratingMatch[1]);
                }
                const reviewsMatch = ratingText.match(/\((\d+(?:,|\s)*\d*)\)/);
                if (reviewsMatch) {
                    data.reviews_count = parseInt(reviewsMatch[1].replace(/[,\s]/g, ''));
                }
            }

            // Price level ($ signs)
            const priceElement = document.querySelector('span[aria-label*="Price"]');
            if (priceElement) {
                const priceText = priceElement.getAttribute('aria-label');
                const priceMatch = priceText?.match(/(\$+)/);
                if (priceMatch) {
                    data.price_level = priceMatch[1];
                }
            }

            // Get all buttons with data-item-id
            const allButtons = document.querySelectorAll('button[data-item-id]');
            
            allButtons.forEach(button => {
                const ariaLabel = button.getAttribute('aria-label') || '';
                const itemId = button.getAttribute('data-item-id');
                
                // Address
                if (itemId && itemId.startsWith('address')) {
                    data.address = button.textContent.trim();
                }
                
                // Website
                if (ariaLabel.toLowerCase().includes('website') || itemId === 'authority') {
                    const link = button.querySelector('a[href]');
                    if (link) {
                        let href = link.getAttribute('href');
                        // Handle Google redirect URLs
                        if (href && href.includes('/url?q=')) {
                            try {
                                const urlParams = new URLSearchParams(href.split('?')[1]);
                                data.website = decodeURIComponent(urlParams.get('q') || '');
                            } catch (e) {
                                data.website = href;
                            }
                        } else if (href && !href.includes('google.com')) {
                            data.website = href;
                        }
                    }
                }
                
                // Phone number
                if (ariaLabel.toLowerCase().includes('phone') || itemId && itemId.includes('phone')) {
                    // Extract phone from aria-label or text
                    const phoneMatch = ariaLabel.match(/[\+\(]?[\d\s\-\(\)\.]+/) || 
                                     button.textContent.match(/[\+\(]?[\d\s\-\(\)\.]+/);
                    if (phoneMatch) {
                        data.phone = phoneMatch[0].trim();
                    }
                }
                
                // Plus code
                if (itemId === 'oloc') {
                    data.plus_code = button.textContent.trim();
                }
            });

            // Check for permanently closed
            const bodyText = document.body.textContent.toLowerCase();
            data.isClosed = bodyText.includes('permanently closed') || 
                           bodyText.includes('closed permanently') ||
                           bodyText.includes('temporarily closed');

            // Look for email in visible content
            const emailMatch = document.body.textContent.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
            if (emailMatch) {
                data.email = emailMatch[0];
            }

            return data;
        });

        return placeData;

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
        requireWebsite = false,
        extractEmailFromWebsite: shouldExtractEmail = true
    } = input;

    if (!queries || queries.length === 0) {
        throw new Error('queries array is required and must not be empty');
    }

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
        requireWebsite,
        extractEmailFromWebsite: shouldExtractEmail
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

                log.info('Scrolling to load all places...');

                let allPlaceUrls = [];
                let scrollAttempts = 0;
                let noNewUrlsCount = 0;
                let previousUrlCount = 0;

                // Scroll and collect all place URLs
                while (scrollAttempts < MAX_SCROLL_ATTEMPTS) {
                    const currentUrls = await extractPlaceUrls(page, log);
                    allPlaceUrls = [...new Set([...allPlaceUrls, ...currentUrls])];

                    if (allPlaceUrls.length === previousUrlCount) {
                        noNewUrlsCount++;
                        if (noNewUrlsCount >= NO_NEW_RESULTS_THRESHOLD) {
                            log.info('No new URLs found, stopping scroll');
                            break;
                        }
                    } else {
                        noNewUrlsCount = 0;
                        previousUrlCount = allPlaceUrls.length;
                    }

                    const scrolled = await scrollResultsPanel(page, log);
                    scrollAttempts++;

                    if (!scrolled) {
                        await page.waitForTimeout(1000);
                    }
                }

                log.info(`Total unique place URLs collected: ${allPlaceUrls.length}`);

                // Now visit each place URL and extract details
                let placesExtractedThisQuery = 0;

                for (let i = 0; i < allPlaceUrls.length; i++) {
                    const placeUrl = allPlaceUrls[i];
                    
                    try {
                        log.info(`[${i + 1}/${allPlaceUrls.length}] Visiting place...`);
                        
                        await page.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                        
                        const placeData = await extractPlaceDetailsFromPage(page, log);
                        
                        if (!placeData || !placeData.business_name) {
                            log.warning('Could not extract business name, skipping');
                            continue;
                        }

                        log.info(`Extracted: ${placeData.business_name}`);

                        // Deduplication first (before any filters)
                        const placeKey = generatePlaceKey(
                            placeData.business_name, 
                            placeData.address || ''
                        );

                        if (seenPlaces.has(placeKey)) {
                            log.info(`⚠️ Duplicate: ${placeData.business_name}`);
                            continue;
                        }

                        seenPlaces.add(placeKey);

                        // Extract email from website if enabled and available
                        if (shouldExtractEmail && placeData.website && !placeData.email) {
                            placeData.email = await extractEmailFromWebsite(placeData.website, log);
                        }

                        // Apply filters AFTER extraction to mark filtered status
                        let filterStatus = 'extracted';
                        
                        if (skipClosedPlaces && placeData.isClosed) {
                            filterStatus = 'closed';
                        } else if (requireWebsite && !placeData.website) {
                            filterStatus = 'no_website';
                        } else if (minRating !== null && (placeData.rating === null || placeData.rating < minRating)) {
                            filterStatus = 'low_rating';
                        }

                        placeData.filter_status = filterStatus;

                        delete placeData.isClosed;

                        // Add query metadata
                        placeData.query_searchTerm = searchTerm;
                        placeData.query_location = location;
                        placeData.query_index = queryIndex + 1;
                        placeData.google_maps_url = placeUrl;

                        await Dataset.pushData(placeData);
                        
                        placesExtractedThisQuery++;
                        totalExtracted++;

                        const statusEmoji = filterStatus === 'extracted' ? '✅' : '⚠️';
                        const statusText = filterStatus === 'extracted' ? '' : ` [${filterStatus}]`;
                        
                        log.info(`${statusEmoji} [${totalExtracted}] ${placeData.business_name}${statusText}`);
                        log.info(`   📞 ${placeData.phone || 'N/A'} | 🌐 ${placeData.website || 'N/A'} | ⭐ ${placeData.rating || 'N/A'} | 📧 ${placeData.email || 'N/A'}`);

                    } catch (error) {
                        log.error(`Error processing place: ${error.message}`);
                        continue;
                    }
                }

                log.info(`\n📊 Completed Query ${queryIndex + 1}/${queries.length}:`);
                log.info(`  - Search: "${searchTerm}"`);
                log.info(`  - Location: "${location}"`);
                log.info(`  - Places found: ${allPlaceUrls.length}`);
                log.info(`  - Places extracted: ${placesExtractedThisQuery}`);
                log.info(`  - Total dataset size: ${totalExtracted}\n`);
            },

            failedRequestHandler({ request, log }) {
                log.error(`Request failed: ${request.url}`);
            }
        });

        const searchQuery = `${searchTerm} ${location}`;
        const url = `${GOOGLE_MAPS_URL}${encodeURIComponent(searchQuery)}?hl=${language}`;
        
        await crawler.run([{ url, userData: { searchTerm, location, queryIndex } }]);

        console.log(`✓ Completed query ${queryIndex + 1}/${queries.length}\n`);
    }

    console.log('\n' + '='.repeat(80));
    console.log('🎉 ACTOR COMPLETED SUCCESSFULLY');
    console.log('='.repeat(80));
    console.log(`Total queries processed: ${queries.length}`);
    console.log(`Total unique places extracted: ${totalExtracted}`);
    console.log('='.repeat(80) + '\n');

} catch (error) {
    console.error('❌ Actor failed:', error);
    throw error;
}

await Actor.exit();
