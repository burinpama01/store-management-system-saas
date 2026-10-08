import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createBeamPolling,canAutoCheckBeam} from '../src/domain/beam-polling';
import type {PendingPayment} from '../src/domain/beam';
const pending={operationId:'op',state:'beam_waiting',input:{method:'beam',gatewayPaymentId:'gw'},beam:{status:'PENDING',expiresAt:null}} as PendingPayment;
beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
describe('Beam automatic status checks',()=>{
 it('stops when the current payment is no longer eligible',async()=>{
  const check=vi.fn(async()=>false);createBeamPolling(check,true);
  await vi.advanceTimersByTimeAsync(30000);expect(check).toHaveBeenCalledTimes(1);
 });
 it('only checks known waiting live gateways, never demo/creation/terminal/checkout recovery',()=>{
  expect(canAutoCheckBeam(pending,false)).toBe(true);
  expect(canAutoCheckBeam(pending,true)).toBe(false);
  expect(canAutoCheckBeam({...pending,input:{...pending.input,gatewayPaymentId:undefined}},false)).toBe(false);
  for(const status of ['PAID','FAILED','EXPIRED','CANCELLED','REVIEW_REQUIRED','LATE_PAID'])expect(canAutoCheckBeam({...pending,beam:{...pending.beam!,status:status as never}},false)).toBe(false);
  expect(canAutoCheckBeam({...pending,state:'unknown'},false)).toBe(false);
  expect(canAutoCheckBeam({...pending,orderId:'order'},false)).toBe(false);
  expect(canAutoCheckBeam({...pending,beam:{...pending.beam!,expiresAt:new Date(0).toISOString()}},false)).toBe(false);
 });
 it('waits three seconds and never overlaps a slow request',async()=>{
  let done!:()=>void;const check=vi.fn(()=>new Promise<void>(r=>{done=r}));const poll=createBeamPolling(check,true);
  await vi.advanceTimersByTimeAsync(3000);expect(check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(12000);expect(check).toHaveBeenCalledTimes(1);
  done();await vi.advanceTimersByTimeAsync(2999);expect(check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);expect(check).toHaveBeenCalledTimes(2);poll.stop();done();
 });
 it('pauses in background and checks immediately on resume without overlapping in-flight work',async()=>{
  const check=vi.fn(async()=>{});const poll=createBeamPolling(check,true);poll.setActive(false);
  await vi.advanceTimersByTimeAsync(9000);expect(check).not.toHaveBeenCalled();
  poll.setActive(true);await vi.advanceTimersByTimeAsync(0);expect(check).toHaveBeenCalledTimes(1);
  poll.stop();await vi.advanceTimersByTimeAsync(9000);expect(check).toHaveBeenCalledTimes(1);
 });
 it('backs off after network errors and resets after recovery',async()=>{
  const check=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);const poll=createBeamPolling(check,true);
  await vi.advanceTimersByTimeAsync(3000);expect(check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5999);expect(check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);expect(check).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(3000);expect(check).toHaveBeenCalledTimes(3);poll.stop();
 });
 it('does not reschedule a request completing after stop or while backgrounded',async()=>{
  let done!:()=>void;const check=vi.fn(()=>new Promise<void>(r=>{done=r}));const poll=createBeamPolling(check,true);
  await vi.advanceTimersByTimeAsync(3000);poll.setActive(false);poll.setActive(true);
  await vi.advanceTimersByTimeAsync(0);expect(check).toHaveBeenCalledTimes(1);
  poll.stop();done();await vi.advanceTimersByTimeAsync(20000);expect(check).toHaveBeenCalledTimes(1);
 });
});
