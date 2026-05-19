import { chromium } from 'playwright';

async function testTelegramUI() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('Переходим на страницу команд...');
    
    // Переходим напрямую на страницу команд (предполагаем что уже залогинены)
    await page.goto('http://localhost:3000/crm/team');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    // Ждем загрузки карточек команд
    try {
      await page.waitForSelector('[data-testid="team-card"]', { timeout: 10000 });
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
    const firstTeamCard = await page.locator('[data-testid="team-card"]').first();
    await firstTeamCard.click();
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