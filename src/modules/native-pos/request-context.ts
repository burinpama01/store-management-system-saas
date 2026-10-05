import { AsyncLocalStorage } from 'node:async_hooks';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Database } from '@/server/integrations/supabase/database.types';

export interface NativeRequestContext { client: SupabaseClient<Database>; user: User; storeId: string | null; expectedTotalSatang?: number }
const context = new AsyncLocalStorage<NativeRequestContext>();
export const getNativeRequestContext = () => context.getStore();
export const withNativeRequestContext = <T>(value: NativeRequestContext, callback: () => T): T => context.run(value, callback);
