import { chromium } from 'playwright';

async function testTelegramUI() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Переходим на страницу логина
    await page.goto('http://localhost:3000/login');
    await page.waitForLoadState('networkidle');
    
    // Логинимся (или переходим напрямую в CRM, если уже залогинены)
    try {
      await page.goto('http://localhost:3000/crm/team');
      await page.waitForLoadState('networkidle');
    } catch (e) {
      // Если не залогинены, пробуем войти
      await page.goto('http://localhost:3000/login');
      await page.click('text="Войти через Google"');
      await page.waitForLoadState('networkidle');
    }

    // Проверяем что мы на странице команд
    await page.goto('http://localhost:3000/crm/team');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('[data-testid="team-card"]', { timeout: 10000 });

    // Делаем скриншот списка команд
    console.log('Делаем скриншот списка команд...');
    await page.screenshot({ path: '/home/runner/work/CheekyCheeseIT_CRM/CheekyCheeseIT_CRM/screenshot-teams-list.png', fullPage: true });

    // Ищем первую карточку команды и кликаем на неё
    const firstTeamCard = await page.locator('[data-testid="team-card"]').first();
    await firstTeamCard.click();
    await page.waitForLoadState('networkidle');

    // Ждем загрузки детальной страницы
    await page.waitForSelector('[data-testid="team-detail"]', { timeout: 10000 });

    // Делаем скриншот детальной страницы
    console.log('Делаем скриншот детальной страницы команды...');
    await page.screenshot({ path: '/home/runner/work/CheekyCheeseIT_CRM/CheekyCheeseIT_CRM/screenshot-team-detail.png', fullPage: true });

    console.log('Скриншоты созданы успешно!');
    console.log('1. screenshot-teams-list.png - список команд');
    console.log('2. screenshot-team-detail.png - детальная страница команды');

  } catch (error) {
    console.error('Ошибка при тестировании:', error);
    // Делаем скриншот ошибки
    await page.screenshot({ path: '/home/runner/work/CheekyCheeseIT_CRM/CheekyCheeseIT_CRM/screenshot-error.png', fullPage: true });
  } finally {
    await browser.close();
  }
}

testTelegramUI();