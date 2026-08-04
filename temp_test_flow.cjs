const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  console.log("Goto /auth");
  await page.goto('https://educadf.se.df.gov.br/auth', {waitUntil: 'domcontentloaded'});
  await page.waitForTimeout(5000);
  
  console.log("Goto /auth/login?id=1");
  await page.goto('https://educadf.se.df.gov.br/auth/login?id=1', {waitUntil: 'domcontentloaded'});
  await page.waitForTimeout(5000);
  
  const currentUrl = page.url();
  console.log("Current URL is: " + currentUrl);
  
  const formHtml = await page.evaluate(() => {
     const un = document.querySelector('#username');
     return un ? "Form exists" : "No form";
  });
  console.log(formHtml);
  
  await browser.close();
})();
