const { chromium } = require('playwright');

(async () => {

    const browser = await chromium.launch({
        headless: false
    });

    const page = await browser.newPage();

    await page.goto('https://www.google.com/maps');

console.log("Browser is open. Press Enter in the terminal to close.");

await new Promise(resolve => {
    process.stdin.once('data', resolve);
});

await browser.close();

})();