import React from 'react';
import {Pressable,StyleSheet,Text,View} from 'react-native';
import {phoneKey} from './domain/phone-keypad';
import {theme} from './theme';
const rows=[['1','2','3'],['4','5','6'],['7','8','9'],['clear','0','backspace']];
export function PhoneKeypad({value,onChange,disabled=false,maxLength=15}:{value:string;onChange:(value:string)=>void;disabled?:boolean;maxLength?:number}){
 return <View style={s.panel}>
  <Text style={s.label}>เบอร์โทรศัพท์ลูกค้า</Text>
  <View style={s.display}><Text accessibilityLabel={`เบอร์โทรศัพท์ ${value||'ยังไม่ได้กรอก'}`} style={[s.number,!value&&s.hint]}>{value||'กดหมายเลขเบอร์โทรศัพท์'}</Text></View>
  {rows.map((row,index)=><View key={index} style={s.row}>{row.map(key=><Pressable key={key} accessibilityRole="button" accessibilityLabel={key==='clear'?'ล้างเบอร์โทรศัพท์':key==='backspace'?'ลบเลขท้าย':`เลข ${key}`} disabled={disabled} onPress={()=>onChange(phoneKey(value,key,maxLength))} style={({pressed})=>[s.key,disabled&&{opacity:.45},pressed&&{backgroundColor:theme.soft}]}><Text style={s.keyText}>{key==='clear'?'ล้าง':key==='backspace'?'⌫':key}</Text></Pressable>)}</View>)}
 </View>;
}
const s=StyleSheet.create({panel:{gap:10},label:{fontWeight:'700',color:theme.text},display:{minHeight:56,borderWidth:1,borderColor:theme.border,borderRadius:12,padding:14,justifyContent:'center',backgroundColor:'#fff'},number:{fontSize:24,color:theme.text},hint:{fontSize:17,color:theme.muted},row:{flexDirection:'row',gap:10},key:{flex:1,minHeight:56,borderWidth:1,borderColor:theme.border,borderRadius:12,backgroundColor:'#fff',alignItems:'center',justifyContent:'center',padding:10},keyText:{fontSize:24,fontWeight:'600',color:theme.text}});
