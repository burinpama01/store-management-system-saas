export function canCreateCustomer(name:string,phone:string){return name.trim().length>0&&name.trim().length<=120&&/^\d{7,15}$/.test(phone);}
export function phoneLookupReady(phone:string){return /^0\d{9}$/.test(phone);}
export function receiptClaimVisible(order:{id:string;status:string},receipt:{orderId:string;claim:{points:number;expiresAt:string;imageUri:string}|null}|null,now=Date.now()){return !!receipt?.claim&&order.status==='paid'&&order.id===receipt.orderId&&receipt.claim.points>0&&Date.parse(receipt.claim.expiresAt)>now&&receipt.claim.imageUri.startsWith('data:image/png;base64,');}
