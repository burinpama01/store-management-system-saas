export const productionBase = 'https://store-os-manage.vercel.app';
export function initialEntryScreen(hasRestoredCart: boolean) { return hasRestoredCart ? 'home' : 'store-picker'; }
export function homeScreen<T extends { screen: string }>(state: T): T { return { ...state, screen: 'home' }; }
