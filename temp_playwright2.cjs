const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://educadf.se.df.gov.br/auth/login?id=1', {waitUntil: 'networkidle'});
  const formHtml = await page.evaluate(() => document.body.innerHTML);
  const fs = require('fs');
  fs.writeFileSync('temp_login_page.html', formHtml);
  console.log("Page dumped");
  await browser.close();
})();
