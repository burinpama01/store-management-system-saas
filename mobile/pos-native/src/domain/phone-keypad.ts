export function phoneKey(value:string,key:string,maxLength=15):string {
 if(key==='clear')return '';
 if(key==='backspace')return value.slice(0,-1);
 return /^\d$/.test(key)&&value.length<maxLength?value+key:value;
}
