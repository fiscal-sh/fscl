const actualApiPackage = '@actual-app/api';

export const api = (await import(actualApiPackage)) as any;
