/**
 * Default categories created with every workspace (BR-05.2). Names are stored in English;
 * `systemKey` lets the UI show them in the user's language once other languages are on.
 */
export interface SeedCategory {
  systemKey: string;
  name: string;
  kind: 'income' | 'expense';
  children?: { systemKey: string; name: string }[];
}

export const DEFAULT_CATEGORIES: SeedCategory[] = [
  { systemKey: 'income.salary', name: 'Salary', kind: 'income' },
  { systemKey: 'income.bonus', name: 'Bonus', kind: 'income' },
  { systemKey: 'income.interest', name: 'Interest income', kind: 'income' },
  { systemKey: 'income.cashback', name: 'Cashback & rewards', kind: 'income' },
  { systemKey: 'income.other', name: 'Other income', kind: 'income' },
  { systemKey: 'expense.housing', name: 'Housing', kind: 'expense', children: [
    { systemKey: 'expense.housing.rent', name: 'Rent' },
    { systemKey: 'expense.housing.utilities', name: 'Utilities' },
  ] },
  { systemKey: 'expense.food', name: 'Food', kind: 'expense', children: [
    { systemKey: 'expense.food.groceries', name: 'Groceries' },
    { systemKey: 'expense.food.restaurants', name: 'Restaurants' },
  ] },
  { systemKey: 'expense.transport', name: 'Transport', kind: 'expense' },
  { systemKey: 'expense.shopping', name: 'Shopping', kind: 'expense', children: [
    { systemKey: 'expense.shopping.clothing', name: 'Clothing' },
    { systemKey: 'expense.shopping.electronics', name: 'Electronics' },
  ] },
  { systemKey: 'expense.household', name: 'Household', kind: 'expense' },
  { systemKey: 'expense.health', name: 'Health', kind: 'expense' },
  { systemKey: 'expense.personal_care', name: 'Personal care', kind: 'expense' },
  { systemKey: 'expense.entertainment', name: 'Entertainment', kind: 'expense' },
  { systemKey: 'expense.education', name: 'Education', kind: 'expense' },
  { systemKey: 'expense.travel', name: 'Travel', kind: 'expense' },
  { systemKey: 'expense.gifts', name: 'Gifts', kind: 'expense' },
  { systemKey: 'expense.taxes', name: 'Taxes', kind: 'expense' },
  { systemKey: 'expense.interest_fees', name: 'Interest and fees', kind: 'expense' },
  { systemKey: 'expense.bank_fees', name: 'Bank fees', kind: 'expense' },
  // E-37, GT-41: the category a cash difference goes to when the user says "I spent it".
  { systemKey: 'expense.untracked', name: 'Untracked spending', kind: 'expense' },
  { systemKey: 'expense.other', name: 'Other expenses', kind: 'expense' },
];
