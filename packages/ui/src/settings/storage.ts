import { DEFAULT_CATEGORY, isCategoryId, type CategoryId } from './categories';
import type { PolicyLevel } from '@ide/protocol';

const CATEGORY_KEY = 'ide.settings.category';
const SCOPE_KEY = 'ide.settings.scope';

export const localStorageOrUndefined = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

export function loadCategory(storage: Storage | undefined): CategoryId {
  try {
    const value = storage?.getItem(CATEGORY_KEY);
    return isCategoryId(value) ? value : DEFAULT_CATEGORY;
  } catch {
    return DEFAULT_CATEGORY;
  }
}

export function saveCategory(storage: Storage | undefined, id: CategoryId): void {
  try {
    storage?.setItem(CATEGORY_KEY, id);
  } catch {
    // a blocked store only means the choice is forgotten
  }
}

export function loadScope(storage: Storage | undefined): PolicyLevel {
  try {
    return storage?.getItem(SCOPE_KEY) === 'ide' ? 'ide' : 'project';
  } catch {
    return 'project';
  }
}

export function saveScope(storage: Storage | undefined, scope: PolicyLevel): void {
  try {
    storage?.setItem(SCOPE_KEY, scope);
  } catch {
    // a blocked store only means the choice is forgotten
  }
}
