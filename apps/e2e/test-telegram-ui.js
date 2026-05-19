const { chromium } = require('@playwright/test');

async function testTelegramUI() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('Переходим на страницу логина...');
    
    // Переходим на страницу логина
    await page.goto('http://localhost:3000/login');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    // Логинимся через API напрямую 
    console.log('Логинимся под Anna Lysenko (HR) через API...');
    
    // Делаем POST запрос на dev-login
    const response = await page.evaluate(async () => {
      try {
        const response = await fetch('http://localhost:3001/api/auth/dev-login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: 'anna.lysenko@cheekycheese.dev'
          }),
          credentials: 'include'
        });
        
        return {
          ok: response.ok,
          status: response.status,
          url: response.url
        };
      } catch (error) {
        return {
          error: error.message
        };
      }
    });

    console.log('Dev-login response:', response);
    
    // Перезагрузим страницу чтобы подхватить cookie
    await page.reload();
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    
    console.log('После релоада URL:', page.url());

    console.log('Переходим на страницу команд...');
    // Переходим на страницу команд
    await page.goto('http://localhost:3000/crm/team');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    // Ждем загрузки карточек команд - используем видимый текст
    try {
      await page.waitForSelector('text="Команда Dmytro"', { timeout: 10000 });
      console.log('Карточки команд найдены');
    } catch (e) {
      console.log('Карточки команд не найдены, делаем скриншот для диагностики');
      await page.screenshot({ path: 'debug-teams-page.png', fullPage: true });
      throw e;
    }

    // Делаем скриншот списка команд
    console.log('Делаем скриншот списка команд...');
    await page.screenshot({ path: 'screenshot-teams-list.png', fullPage: true });

    // Ищем первую карточку команды и кликаем на неё
    await page.click('text="Команда Dmytro"');
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Ждем загрузки детальной страницы
    try {
      await page.waitForSelector('[data-testid="team-detail"]', { timeout: 10000 });
      console.log('Детальная страница команды загружена');
    } catch (e) {
      console.log('Детальная страница не найдена, проверяем URL');
      console.log('Current URL:', page.url());
      await page.screenshot({ path: 'debug-detail-page.png', fullPage: true });
      // Возможно страница загрузилась, но с другим селектором, продолжаем
    }

    // Делаем скриншот детальной страницы
    console.log('Делаем скриншот детальной страницы команды...');
    await page.screenshot({ path: 'screenshot-team-detail.png', fullPage: true });

    console.log('Скриншоты созданы успешно!');
    console.log('1. screenshot-teams-list.png - список команд');
    console.log('2. screenshot-team-detail.png - детальная страница команды');

  } catch (error) {
    console.error('Ошибка при тестировании:', error);
    console.log('Current URL:', await page.url());
    console.log('Page title:', await page.title());
    // Делаем скриншот ошибки
    await page.screenshot({ path: 'screenshot-error.png', fullPage: true });
  } finally {
    await browser.close();
  }
}

testTelegramUI();