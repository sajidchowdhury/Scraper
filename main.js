const { chromium } = require('playwright');

(async () => {

    const browser = await chromium.launch({
        headless: false,
        slowMo: 200
    });

    const page = await browser.newPage({
        viewport: { width: 1400, height: 900 }
    });

    await page.goto('https://www.google.com/maps', {
        waitUntil: 'networkidle'
    });

    console.log("Google Maps Loaded");

    await page.waitForTimeout(3000);

    await page.locator('input#searchboxinput').fill('Restaurant Toronto');

    await page.keyboard.press('Enter');

console.log("Waiting for search results...");

await page.waitForSelector('div[role="feed"]', {
    timeout: 30000
});

console.log("Business list found!");

await new Promise(() => {});

})();