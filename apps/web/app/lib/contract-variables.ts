/**
 * Available template variables for contract body_markdown.
 * Used in the ADMIN split-view editor as a side-panel hint.
 *
 * Variable names match the resolver in SignedContractsService.resolveVariables().
 */
export const CONTRACT_VARIABLES: Record<string, string> = {
  '{{employeeName}}': 'Полное имя сотрудника',
  '{{employeeEmail}}': 'Email сотрудника',
  '{{role}}': 'Роль (HR / Синьор / Джун / Дроп / Бухгалтер)',
  '{{onboardingDate}}': 'Дата подписания контракта',
  '{{companyName}}': 'Название компании (Cheeky Cheese IT)',
  '{{walletUsdt}}': 'USDT ERC-20 кошелёк (если указан)',
  '{{bankUahFop}}': 'Банковские реквизиты UAH (ФОП)',
  '{{preferredMethod}}': 'Предпочтительный метод оплаты (crypto / fop)',
  '{{contractNumber}}': 'Номер контракта (генерируется автоматически, CHK-N-YYYY)',
}
