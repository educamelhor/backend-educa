const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://educadf.se.df.gov.br/auth', {waitUntil: 'networkidle'});
  const links = await page.evaluate(() => Array.from(document.querySelectorAll('a')).map(a => ({ text: a.innerText, href: a.href })));
  console.log(JSON.stringify(links, null, 2));
  await browser.close();
})();
