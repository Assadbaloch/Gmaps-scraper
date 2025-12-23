# Google Maps Bulk Scraper with Email Extraction

Production-ready Apify Actor for **bulk Google Maps scraping** with unlimited results per query. Processes queries in chronological order and stores all results in a single unified dataset.

## 🚀 Key Features

- ✅ **Bulk Query Support**: Process multiple search queries sequentially
- ✅ **Unlimited Results**: No limit on results per query - scrapes ALL available places
- ✅ **Chronological Processing**: Queries processed in exact order provided
- ✅ **Single Dataset**: All results stored in one unified dataset
- ✅ **Global Deduplication**: Removes duplicates across ALL queries
- ✅ **Email Extraction**: Automatic email extraction from business websites
- ✅ **Advanced Filtering**: Rating, website, and status filters
- ✅ **Robust Error Handling**: Retries, timeouts, and comprehensive logging

## 📥 Input Format

### Bulk Queries Structure

```json
{
  "queries": [
    {
      "searchTerm": "italian restaurants",
      "location": "New York, NY"
    },
    {
      "searchTerm": "sushi restaurants",
      "location": "Brooklyn, NY"
    },
    {
      "searchTerm": "coffee shops",
      "location": "Manhattan, NY"
    }
  ],
  "language": "en",
  "skipClosedPlaces": true,
  "minRating": 4.0,
  "requireWebsite": false
}
```

### Input Parameters

- **queries** (required, array): Array of query objects, each containing:
  - **searchTerm** (required, string): What to search for
  - **location** (required, string): Where to search
- **language** (optional, string, default: "en"): Language code
- **skipClosedPlaces** (optional, boolean, default: true): Skip closed locations
- **minRating** (optional, number): Minimum rating filter (1-5)
- **requireWebsite** (optional, boolean, default: false): Only include places with websites

## 📤 Output Format

Each place includes query metadata:

```json
{
  "business_name": "Joe's Pizza",
  "address": "123 Main St, New York, NY 10001",
  "phone": "+1 212-555-0123",
  "email": "info@joespizza.com",
  "website": "https://joespizza.com",
  "rating": 4.5,
  "query_searchTerm": "italian restaurants",
  "query_location": "New York, NY",
  "query_index": 1
}
```

## 🔧 How It Works

1. **Sequential Processing**: Queries are processed one by one in chronological order
2. **Complete Scraping**: Each query is scraped until ALL results are extracted
3. **Smart Scrolling**: Automatically scrolls and loads more results until exhausted
4. **Real-time Filtering**: Applies filters (rating, website, closed status) during extraction
5. **Email Extraction**: Visits business websites to extract email addresses
6. **Global Deduplication**: Removes duplicates across all queries by name + address
7. **Single Dataset**: All results saved to one unified Apify Dataset

## 📊 Processing Flow

```
Query 1 → Extract ALL places → Apply filters → Save to dataset
Query 2 → Extract ALL places → Apply filters → Save to dataset
Query 3 → Extract ALL places → Apply filters → Save to dataset
...
Query N → Extract ALL places → Apply filters → Save to dataset
```

## ⚡ Performance

- **No result limits**: Extracts every available place from Google Maps
- **Efficient deduplication**: Global Set-based deduplication across all queries
- **Smart scrolling**: Detects end of results automatically
- **Parallel email extraction**: Uses separate browser contexts for speed

## 🎯 Use Cases

- **Multi-location scraping**: Same business type across different cities
- **Multi-category scraping**: Different business types in same location
- **Comprehensive database building**: Extract entire business categories
- **Market research**: Gather all competitors in multiple regions
- **Lead generation**: Bulk extraction for sales prospecting

## 💡 Example Scenarios

### Scenario 1: Same business type, multiple locations
```json
{
  "queries": [
    { "searchTerm": "dentists", "location": "Los Angeles, CA" },
    { "searchTerm": "dentists", "location": "San Diego, CA" },
    { "searchTerm": "dentists", "location": "San Francisco, CA" }
  ]
}
```

### Scenario 2: Multiple business types, same location
```json
{
  "queries": [
    { "searchTerm": "restaurants", "location": "Chicago, IL" },
    { "searchTerm": "cafes", "location": "Chicago, IL" },
    { "searchTerm": "bars", "location": "Chicago, IL" }
  ]
}
```

### Scenario 3: Targeted quality leads
```json
{
  "queries": [
    { "searchTerm": "law firms", "location": "Boston, MA" },
    { "searchTerm": "accounting firms", "location": "Boston, MA" }
  ],
  "minRating": 4.5,
  "requireWebsite": true
}
```

## 🛡️ Limitations

- Respects Google Maps rate limiting and anti-bot measures
- Email extraction limited to homepage (not subpages)
- Processing time increases with number of queries and results
- Some businesses may have incomplete information

## 📝 Tips for Best Results

- Use specific search terms for better targeting
- Combine related searches in one run for efficiency
- Enable `requireWebsite` if emails are critical
- Use `minRating` to focus on quality businesses
- Monitor logs for progress and debugging

## 🆘 Support

For issues or questions, please contact support through the Apify platform.