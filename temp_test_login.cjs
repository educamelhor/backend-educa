const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://educadf.se.df.gov.br/auth/login?id=1', {waitUntil: 'networkidle'});
  
  // Accept cookies
  await page.evaluate(() => {
    const aceitar = [...document.querySelectorAll('a, button')].find(el => el.textContent.trim().toLowerCase() === 'aceitar');
    if (aceitar) aceitar.click();
  });
  await page.waitForTimeout(1000);

  // Fill credentials
  await page.fill('#username', '2586886');
  await page.fill('#password-input', 'sedf@6886');
  
  // Click acessar
  await page.evaluate(() => {
    document.querySelector('.login-lam-btn-acessar').click();
  });

  await page.waitForTimeout(3000);
  const html = await page.evaluate(() => document.body.innerHTML);
  const fs = require('fs');
  fs.writeFileSync('temp_after_login.html', html);
  await page.screenshot({ path: 'temp_after_login.png' });
  console.log("Login submitted and saved.");
  await browser.close();
})();
