import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from './index.js';
import { users, appSettings, categories, subcategories, keywords } from './schema.js';
import { hashPassword } from '../auth/password.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = resolve(__dirname, '../../../samples/category_seed.json');

// Default curated-icon names for the seeded categories/subcategories. Names must
// exist in the client icon pool (client/src/lib/categoryIcons.js). Unmapped
// entries seed with no icon (the user can pick one later).
const CATEGORY_ICONS = {
  'Bank Fees': 'landmark',
  'Home Improvement': 'hammer',
  'Rent & Utilities': 'home',
  Entertainment: 'film',
  Income: 'wallet',
  'Transfer In/Out': 'arrow-left-right',
  'Food & Drink': 'utensils',
  'General Merchandise': 'shopping-bag',
  'General Services': 'briefcase',
  Medical: 'activity',
  Transportation: 'car',
  'Personal Care': 'scissors',
  Travel: 'plane',
  'Government & Non-profit': 'landmark',
  Company: 'building',
  'Cash Withdrawal': 'banknote',
};
const SUBCATEGORY_ICONS = {
  Groceries: 'shopping-cart',
  Restaurants: 'utensils',
  'Coffee Shops & Ice-creams': 'coffee',
  'Fast Food': 'utensils',
  Fuel: 'fuel',
  Parking: 'car',
  'Public Transportation': 'bus',
  'Car Maintenance': 'wrench',
  Electricity: 'zap',
  Water: 'droplet',
  Gas: 'flame',
  Internet: 'wifi',
  Phone: 'smartphone',
  Rent: 'home',
  Clothing: 'shirt',
  Electronics: 'smartphone',
  Pharmacy: 'pill',
  'Gym Memberships': 'dumbbell',
  'School fees': 'graduation-cap',
  Flights: 'plane',
  Hotels: 'bed',
  Salary: 'wallet',
  'Charitable Donations': 'gift',
  'Subscription Services': 'music',
  Movies: 'film',
  Furniture: 'home',
};

// Idempotent boot seeding: ensure the app-settings singleton exists and, on a
// fresh database with no users, create the default admin (admin/admin). Then
// backfill category seeds for any user that has none (self-healing across
// schema additions and for the boot admin).
export async function seedDefaults() {
  let settings = db.select().from(appSettings).where(eq(appSettings.id, 1)).get();
  if (!settings) {
    db.insert(appSettings).values({ id: 1 }).run();
    settings = db.select().from(appSettings).where(eq(appSettings.id, 1)).get();
  }

  const anyUser = db.select({ id: users.id }).from(users).get();
  if (!anyUser) {
    const passwordHash = await hashPassword('admin');
    db.insert(users)
      .values({
        username: 'admin',
        passwordHash,
        isAdmin: true,
        passwordIsDefault: true,
        defaultCurrency: settings.defaultCurrency,
        globalFuzzyDistance: settings.globalFuzzyDistance,
      })
      .run();
  }

  for (const { id } of db.select({ id: users.id }).from(users).all()) {
    seedUserCategories(id);
  }
  backfillSeedIcons();
}

// Assigns default icons to seed-named categories/subcategories that don't have
// one yet (e.g. users seeded before icons existed). Only touches NULL icons, so
// user choices are never overwritten.
export function backfillSeedIcons() {
  for (const [name, icon] of Object.entries(CATEGORY_ICONS)) {
    db.update(categories)
      .set({ icon })
      .where(and(eq(categories.name, name), isNull(categories.icon)))
      .run();
  }
  for (const [name, icon] of Object.entries(SUBCATEGORY_ICONS)) {
    db.update(subcategories)
      .set({ icon })
      .where(and(eq(subcategories.name, name), isNull(subcategories.icon)))
      .run();
  }
}

// Seeds a user's initial categories/subcategories/keywords from the shipped seed
// file. No-op if the user already has categories, so it is safe to call on every
// boot and at user-creation time. The file has the shape the Categories page
// exports (`GET /api/categories/export`), so an export can become a seed as is;
// fields it leaves out fall back to the original seed rules (per CLAUDE.md):
//   - `category_type` in the seed is ignored (expense/income is derived).
//   - `icon` / `businessDefault` / `isHidden` / `isCashWithdrawal` are used
//     when present; otherwise `Company` seeds business, `Transfer In/Out`
//     hidden, and icons come from the name.
//   - `keywords` on a category (no subcategory) are seeded too.
//   - `Unknown` is dropped (uncategorized is a distinct NULL state).
//   - a `Cash Withdrawal` category (isCashWithdrawal=true) is appended unless
//     the file already flags one.
export function seedUserCategories(userId) {
  const already = db.select({ id: categories.id }).from(categories).where(eq(categories.userId, userId)).get();
  if (already) return;

  const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'));

  db.transaction(() => {
    let catOrder = 0;
    for (const cat of seed.categories ?? []) {
      if (cat.name === 'Unknown') continue;

      const category = db
        .insert(categories)
        .values({
          userId,
          name: cat.name,
          icon: cat.icon ?? CATEGORY_ICONS[cat.name] ?? null,
          businessDefault: ['business', 'personal', 'mixed'].includes(cat.businessDefault) ? cat.businessDefault : cat.name === 'Company' ? 'business' : 'personal',
          isHidden: cat.isHidden ?? cat.name === 'Transfer In/Out',
          isCashWithdrawal: Boolean(cat.isCashWithdrawal),
          sortOrder: catOrder++,
        })
        .returning()
        .get();

      for (const text of cat.keywords ?? []) {
        db.insert(keywords).values({ userId, categoryId: category.id, subcategoryId: null, text }).run();
      }

      let subOrder = 0;
      for (const sub of cat.subcategories ?? []) {
        const subcategory = db
          .insert(subcategories)
          .values({
            userId,
            categoryId: category.id,
            name: sub.name,
            icon: sub.icon ?? SUBCATEGORY_ICONS[sub.name] ?? null,
            sortOrder: subOrder++,
          })
          .returning()
          .get();

        for (const text of sub.keywords ?? []) {
          db.insert(keywords)
            .values({ userId, categoryId: category.id, subcategoryId: subcategory.id, text })
            .run();
        }
      }
    }

    if ((seed.categories ?? []).some((c) => c.isCashWithdrawal)) return;
    db.insert(categories)
      .values({
        userId,
        name: 'Cash Withdrawal',
        icon: CATEGORY_ICONS['Cash Withdrawal'] ?? null,
        businessDefault: 'personal',
        isHidden: false,
        isCashWithdrawal: true,
        sortOrder: catOrder++,
      })
      .run();
  });
}
