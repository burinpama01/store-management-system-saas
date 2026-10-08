import type {PendingPayment} from './beam';

export function canAutoCheckBeam(pending:PendingPayment|null,demo:boolean,now=Date.now()):boolean {
 const qr=pending?.beam;
 return !demo && pending?.input.method==='beam' && pending.state==='beam_waiting' && !pending.orderId &&
  !!pending.input.gatewayPaymentId && !!qr && ['PENDING','REQUIRES_ACTION','PROCESSING'].includes(qr.status) &&
  (!qr.expiresAt || Date.parse(qr.expiresAt)>now);
}

/** Schedule after settlement, not at fixed intervals: slow requests cannot overlap. */
export function createBeamPolling(check:()=>Promise<void|boolean>,initialActive:boolean){
 let active=initialActive,stopped=false,inFlight=false,failures=0;
 let timer:ReturnType<typeof setTimeout>|undefined;
 const clear=()=>{if(timer!==undefined){clearTimeout(timer);timer=undefined;}};
 const schedule=(delay:number)=>{clear();if(active&&!stopped&&!inFlight)timer=setTimeout(()=>void tick(),delay);};
 async function tick(){
  timer=undefined;if(stopped||!active||inFlight)return;inFlight=true;
  try{if(await check()===false)stopped=true;failures=0;}catch{failures=Math.min(failures+1,4);}
  finally{inFlight=false;schedule(Math.min(3000*2**failures,30000));}
 }
 schedule(3000);
 return {setActive(next:boolean){if(next===active||stopped)return;active=next;clear();if(active)schedule(0);},stop(){stopped=true;clear();}};
}
