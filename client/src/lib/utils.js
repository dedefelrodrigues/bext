import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// shadcn-svelte class-merge helper.
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
