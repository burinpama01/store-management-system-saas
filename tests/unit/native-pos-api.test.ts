import { beforeEach, describe, expect, it, vi } from 'vitest';
const beamMocks=vi.hoisted(()=>({prepare:vi.fn(),check:vi.fn(),feature:vi.fn(),ready:vi.fn()}));
vi.mock('@/modules/native-pos/beam',()=>({prepareNativeBeam:beamMocks.prepare,checkNativeBeam:beamMocks.check}));
vi.mock('@/modules/payments/beam-service',()=>({isBeamReadyForStore:beamMocks.ready}));
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), stores: vi.fn(), permissions: vi.fn(), billing: vi.fn(), checkout: vi.fn(), find: vi.fn(), cancel: vi.fn(), getOrder: vi.fn(), products: vi.fn(), connectOrder: vi.fn(), link: vi.fn(), apply: vi.fn(), customers:vi.fn(), coupon:vi.fn(), customer:vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock('@/server/integrations/supabase/server', () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock('@/modules/auth/session', () => ({ getUserStores: mocks.stores }));
vi.mock('@/modules/auth/guards', () => ({ getResolvedCurrentPermissions: mocks.permissions, requireFeature: beamMocks.feature }));
vi.mock('@/modules/customers/repository',()=>({getCustomerById:mocks.customer}));
vi.mock('@/modules/billing/billing-service', () => ({ getOrganizationBillingState: mocks.billing }));
vi.mock('@/modules/billing/pricing', () => ({ hasBillingAccess: (value: { active: boolean }) => value.active }));
vi.mock('@/modules/catalog/repository', () => ({ listProducts: mocks.products, listCategories: async () => ({ data: [], error: null }) }));
vi.mock('@/app/pos/actions', () => ({ checkoutAndPayAction: mocks.checkout, listTodayOrdersAction: vi.fn(),searchPosCustomersAction:mocks.customers,evaluatePosCouponAction:mocks.coupon }));
vi.mock('@/modules/connect/repository', () => ({ getConnectOrderById: mocks.connectOrder, getChannelLinkById: mocks.link, listChannelLinksByStore: vi.fn() }));
vi.mock('@/modules/connect/status-sync', () => ({ applyPosStatus: mocks.apply }));
vi.mock('@/app/api/ai/voice-intent/route', () => ({ POST: vi.fn() }));
vi.mock('@/modules/pos/order-repository', () => ({ getOrder: mocks.getOrder }));
vi.mock('@/modules/native-pos/operation', () => ({ findNativeOrderId: mocks.find, cancelNativeOperation: mocks.cancel, nativeOperationKey: (user: string, store: string, key: string) => `${user}/${store}/${key}` }));
import { GET, POST } from '@/app/api/mobile/pos/[operation]/route';
import { getNativeRequestContext } from '@/modules/native-pos/request-context';
const store = '10000000-0000-4000-8000-000000000001';
const product = '20000000-0000-4000-8000-000000000002';
const operation = '30000000-0000-4000-8000-000000000003';
const body = { operationId: operation, expectedTotalSatang: 6500, method: 'cash', receivedSatang: 10000, lines: [{ productId: product, variantId: null, optionIds: [], quantity: 1, note: '' }] };
function request(name: string, payload?: unknown, token = true, selected = store) {
  const req = new Request(`https://example.test/api/mobile/pos/${name}`, { method: payload ? 'POST' : 'GET', headers: { ...(token ? { Authorization: 'Bearer test-token' } : {}), 'X-Store-Id': selected }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  return (payload ? POST : GET)(req, { params: Promise.resolve({ operation: name.split('?')[0] }) });
}
beforeEach(() => {
  vi.clearAllMocks();
  beamMocks.feature.mockResolvedValue(undefined);beamMocks.ready.mockResolvedValue(true);
  beamMocks.prepare.mockResolvedValue({gatewayPaymentId:product,totalSatang:6500,status:'PENDING',imageUri:null,expiresAt:null});
  beamMocks.check.mockResolvedValue({gatewayPaymentId:product,totalSatang:6500,status:'PAID',imageUri:null,expiresAt:null});
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co'); vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'public-test');
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user' } }, error: null });
  mocks.stores.mockResolvedValue({ stores: [{ id: store, name: 'ร้านทดสอบ' }] });
  mocks.permissions.mockResolvedValue({ ctx: { storeId: store, organizationId: 'org', role: 'cashier' }, resolved: { can: () => true } });
  mocks.billing.mockResolvedValue({ active: true });
  mocks.find.mockResolvedValue(null);
  mocks.products.mockResolvedValue({ error: null, data: [{ id: product, storeId: store, categoryId: 'c', name: 'กาแฟ', basePrice: 65, isActive: true, availableForPos: true, variants: [], modifierGroups: [] }] });
  mocks.checkout.mockResolvedValue({ orderId: 'order', order: null, failedStage: null, error: null });
  mocks.customers.mockResolvedValue({customers:[{id:product,name:'ลูกค้าทดสอบ',phone:'0801234567',email:'private@example.test'}],error:null});
  mocks.customer.mockResolvedValue({data:{id:product,storeId:store,isActive:true},error:null});
  mocks.coupon.mockResolvedValue({couponId:operation,normalizedCode:'SAVE',discount:10,error:null});
});
describe('native API authorization and checkout', () => {
  it('protects exact phone lookup before accessing customer records',async()=>{
    const name='customer-phone?phone=0812345678';
    expect((await request(name,undefined,false)).status).toBe(401);
    expect((await request(name,undefined,true,product)).status).toBe(403);
    mocks.permissions.mockResolvedValueOnce({ctx:{storeId:store,organizationId:'org',role:'cashier'},resolved:{can:()=>false}});expect((await request(name)).status).toBe(403);
    beamMocks.feature.mockRejectedValueOnce(Error('feature denied'));expect((await request(name)).status).toBe(403);
    expect((await request('customer-phone?phone=081')).status).toBe(400);
  });
  it('gates new customer and receipt operations with bearer, selected store, pos.use and loyalty entitlement',async()=>{
    for(const name of ['customer-create','receipt']){
      expect((await request(name,{},false)).status).toBe(401);
      expect((await request(name,{},true,product)).status).toBe(403);
      mocks.permissions.mockResolvedValueOnce({ctx:{storeId:store,organizationId:'org',role:'cashier'},resolved:{can:()=>false}});
      expect((await request(name,{})).status).toBe(403);
      beamMocks.feature.mockRejectedValueOnce(Error('feature denied'));
      expect((await request(name,{})).status).toBe(403);
      expect((await request(name,{})).status).toBe(400);
    }
  });
  it('prepares Beam from the server quote and blocks client prices or missing entitlement',async()=>{
    const payload={operationId:operation,expectedTotalSatang:6500,lines:body.lines};
    expect((await request('beam-prepare',payload)).status).toBe(200);
    expect(beamMocks.prepare).toHaveBeenCalledWith({storeId:store,organizationId:'org',userId:'user'},operation,6500);
    expect((await request('beam-prepare',{...payload,expectedTotalSatang:6000})).status).toBe(409);
    expect((await request('beam-prepare',{...payload,expectedTotalSatang:1})).status).toBe(400);
    expect((await request('beam-prepare',{...payload,amount:1})).status).toBe(400);
    beamMocks.feature.mockRejectedValueOnce(Error('feature denied'));
    expect((await request('beam-prepare',payload)).status).toBe(403);
    expect(beamMocks.prepare).toHaveBeenCalledTimes(1);
  });
  it('requires paid bound Beam before checkout and sends the gateway to existing web settlement',async()=>{
    const payload={...body,method:'beam',gatewayPaymentId:product};
    beamMocks.check.mockResolvedValueOnce({gatewayPaymentId:product,totalSatang:6500,status:'PENDING'});
    expect((await request('checkout',payload)).status).toBe(409);expect(mocks.checkout).not.toHaveBeenCalled();
    expect((await request('checkout',payload)).status).toBe(200);
    expect(mocks.checkout).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({method:'other',amount:65}),expect.objectContaining({beam:{gatewayPaymentId:product}}));
    expect((await request('checkout',{...body,gatewayPaymentId:product})).status).toBe(400);
    expect((await request('checkout',{...body,method:'beam'})).status).toBe(400);
  });
  it('scopes Beam status to operation and rejects no-auth, foreign stores and payload injection',async()=>{
    const payload={operationId:operation,gatewayPaymentId:product,expectedTotalSatang:6500};
    expect((await request('beam-status',payload)).status).toBe(200);
    expect((await request('beam-status',payload,false)).status).toBe(401);
    expect((await request('beam-status',payload,true,product)).status).toBe(403);
    expect((await request('beam-status',{...payload,status:'PAID'})).status).toBe(400);
  });
  it('bounds customer queries and returns only minimal masked customer DTO', async()=>{
    expect((await request('customers')).status).toBe(400);
    const response=await GET(new Request('https://example.test/api/mobile/pos/customers?q=test',{headers:{Authorization:'Bearer test-token','X-Store-Id':store}}),{params:Promise.resolve({operation:'customers'})});
    expect(await response.json()).toEqual({customers:[{id:product,name:'ลูกค้าทดสอบ',phoneHint:'••••4567'}]});
    expect(mocks.customers).toHaveBeenCalledWith('test');
  });
  it('quotes server coupon and manual discount, then sends authoritative net payment with rewards options',async()=>{
    const sales={customerId:product,couponCode:'save',manualDiscountSatang:500};
    expect(await (await request('quote',{lines:body.lines,...sales})).json()).toMatchObject({quote:{subtotalSatang:6500,manualDiscountSatang:500,couponDiscountSatang:1000,totalSatang:5000}});
    expect((await request('checkout',{...body,...sales,expectedTotalSatang:5000})).status).toBe(200);
    expect(mocks.checkout).toHaveBeenCalledWith(expect.objectContaining({subtotal:65,discount:5,total:60}),expect.objectContaining({amount:50,changeAmount:50}),expect.objectContaining({customerId:product,couponCode:'SAVE',clientCouponDiscountAmount:10}));
  });
  it('rejects manual discount permission, coupon amount changes and quote price injection before writes',async()=>{
    mocks.permissions.mockResolvedValueOnce({ctx:{storeId:store,organizationId:'org',role:'cashier'},resolved:{can:(p:string)=>p!=='pos.discount'}});
    expect((await request('quote',{lines:body.lines,manualDiscountSatang:100})).status).toBe(400);
    expect((await request('quote',{lines:body.lines,couponId:operation})).status).toBe(400);
    expect(await (await request('checkout',{...body,couponCode:'SAVE',expectedTotalSatang:6000})).json()).toMatchObject({notCreated:true});
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('accepts PostgreSQL legacy store UUIDs while rejecting malformed and inaccessible IDs', async () => {
    const legacy = 'cccccccc-0000-0000-0000-000000000001';
    mocks.stores.mockResolvedValue({ stores: [{ id: legacy, name: 'Main Branch' }] });
    expect((await request('bootstrap', undefined, true, legacy)).status).toBe(200);
    expect((await request('bootstrap', undefined, true, 'not-a-uuid')).status).toBe(400);
    expect((await request('bootstrap', undefined, true, 'cccccccc-0000-0000-0000-000000000002')).status).toBe(403);
  });
  it('allows an active subscription to bootstrap and blocks inactive or missing billing before reading products', async () => {
    expect((await request('bootstrap')).status).toBe(200);
    mocks.products.mockClear();
    mocks.billing.mockResolvedValueOnce({ active: false });
    expect((await request('bootstrap')).status).toBe(403);
    mocks.billing.mockResolvedValueOnce(null);
    expect((await request('bootstrap')).status).toBe(403);
    expect(mocks.products).not.toHaveBeenCalled();
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('rejects absent or unverified Bearer tokens and inaccessible explicit stores', async () => {
    expect((await request('bootstrap', undefined, false)).status).toBe(401);
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: new Error('expired') });
    expect((await request('bootstrap')).status).toBe(401);
    expect((await request('bootstrap', undefined, true, product)).status).toBe(403);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('enforces subscription and permission before any checkout', async () => {
    mocks.billing.mockResolvedValueOnce({ active: false }); expect((await request('checkout', body)).status).toBe(403);
    mocks.permissions.mockResolvedValueOnce({ ctx: { storeId: store, organizationId: 'org', role: 'cashier' }, resolved: { can: () => false } });
    expect((await request('checkout', body)).status).toBe(403); expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('accepts legacy catalog IDs but keeps operation UUID validation strict', async () => {
    const legacyProduct = 'dddddddd-0000-0000-0000-000000000001';
    mocks.products.mockResolvedValue({ error: null, data: [{ id: legacyProduct, storeId: store, categoryId: 'c', name: 'กาแฟ', basePrice: 65, isActive: true, availableForPos: true, variants: [], modifierGroups: [] }] });
    expect((await request('checkout', { ...body, lines: [{ ...body.lines[0], productId: legacyProduct }] })).status).toBe(200);
    mocks.checkout.mockClear();
    expect((await request('checkout', { ...body, operationId: legacyProduct })).status).toBe(400);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('accepts the mobile payload, reprices, and passes a user/store-bound durable key', async () => {
    mocks.checkout.mockImplementationOnce(async () => {
      expect(getNativeRequestContext()).toMatchObject({ storeId: store, user: { id: 'user' }, expectedTotalSatang: 6500 });
      return { orderId: 'order', order: null, failedStage: null, error: null };
    });
    expect((await request('checkout', body)).status).toBe(200);
    expect(mocks.checkout).toHaveBeenCalledWith(expect.objectContaining({ total: 65 }), expect.objectContaining({ amount: 65, receivedAmount: 100, changeAmount: 35 }), { idempotencyKey: `user/${store}/${operation}`, paymentIdempotencyKey: `user/${store}/${operation}` });
  });
  it('rejects price changes and injected client prices before writing', async () => {
    const changed = await request('checkout', { ...body, expectedTotalSatang: 6000 });
    expect(changed.status).toBe(409); expect(await changed.json()).toMatchObject({ notCreated: true });
    expect((await request('checkout', { ...body, lines: [{ ...body.lines[0], unitPrice: 1 }] })).status).toBe(400);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('reconciles a paid previous operation without creating or paying again', async () => {
    mocks.find.mockResolvedValue('previous'); mocks.getOrder.mockResolvedValue({ error: null, data: { id: 'previous', storeId: store, organizationId: 'org', status: 'paid', orderNumber: 'POS-001', total: 65, createdAt: '2026-09-09', items: [] } });
    const response = await request('checkout', body);
    expect(await response.json()).toMatchObject({ error: null, orderId: 'previous', order: { number: 'POS-001' } });
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('returns a pre-mutation rejection for unavailable products and removed options', async () => {
    mocks.products.mockResolvedValueOnce({ error: null, data: [] });
    expect(await (await request('checkout', body)).json()).toMatchObject({ notCreated: true });
    expect(await (await request('checkout', { ...body, lines: [{ ...body.lines[0], optionIds: [operation] }] })).json()).toMatchObject({ notCreated: true });
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('rejects JDC status changes when link belongs to another store', async () => {
    mocks.connectOrder.mockResolvedValue({ linkId: 'link', internalOrderId: 'order' }); mocks.link.mockResolvedValue({ storeId: product, channel: 'jdc' });
    expect((await request('delivery-status', { id: operation, next: 'accepted' })).status).toBe(404); expect(mocks.apply).not.toHaveBeenCalled();
  });
  it.each(['cancelled', 'voided', 'refunded'])('releases a %s operation without claiming payment or charging again', async status => {
    mocks.find.mockResolvedValue('previous'); mocks.getOrder.mockResolvedValue({ error: null, data: { id: 'previous', storeId: store, organizationId: 'org', status, orderNumber: 'POS-001', total: 65, createdAt: '2026-09-09', items: [] } });
    const response = await request('checkout', body);
    expect(await response.json()).toMatchObject({ error: null, outcome: 'closed', closedStatus: status, orderId: 'previous' });
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('releases an unknown operation only after a successful durable cancellation result', async () => {
    mocks.cancel.mockResolvedValueOnce({ outcome: 'not_created' });
    expect(await (await request('cancel-operation', { operationId: operation })).json()).toEqual({ outcome: 'not_created' });
    expect(mocks.cancel).toHaveBeenCalledWith(store, 'user', operation);
    mocks.cancel.mockRejectedValueOnce(new Error('migration unavailable'));
    expect((await request('cancel-operation', { operationId: operation })).status).toBe(400);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
});
