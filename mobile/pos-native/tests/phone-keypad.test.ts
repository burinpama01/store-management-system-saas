import {expect,it} from 'vitest';
import {phoneKey} from '../src/domain/phone-keypad';
it('keeps leading zero and accepts only phone digits up to the limit',()=>{
 expect(phoneKey('','0')).toBe('0');expect(phoneKey('08','9')).toBe('089');
 expect(phoneKey('081234567890123','9')).toBe('081234567890123');
 expect(phoneKey('08','a')).toBe('08');expect(phoneKey('08','.')).toBe('08');
});
it('supports erase and clear without a system keyboard',()=>{
 expect(phoneKey('081','backspace')).toBe('08');expect(phoneKey('','backspace')).toBe('');
 expect(phoneKey('081','clear')).toBe('');
});
