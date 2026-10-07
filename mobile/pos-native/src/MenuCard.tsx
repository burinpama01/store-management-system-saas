import React, { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from './theme';

export function MenuCard({ name, category, price, imageUrl, width, favorite, available, disabled, onAdd, onFavorite }: {
  name: string; category?: string; price: string; width: number; favorite: boolean;
  imageUrl?: string | null; available: boolean; disabled: boolean; onAdd: () => void; onFavorite: () => void;
}) {
  const [failed,setFailed]=useState(false);
  useEffect(()=>setFailed(false),[imageUrl]);
  return <View style={[styles.card, { width, maxWidth: '100%' }]}>
    <View style={styles.top}><Text style={styles.category}>{category}</Text><Pressable accessibilityRole="button" accessibilityLabel={`${favorite ? 'ลบ' : 'เพิ่ม'} ${name} ในรายการโปรด`} accessibilityState={{ selected: favorite }} onPress={onFavorite} style={styles.star}><Text style={styles.starText}>{favorite ? '★' : '☆'}</Text></Pressable></View>
    <Pressable accessibilityRole="button" accessibilityLabel={`${name} ${price}`} disabled={disabled || !available} onPress={onAdd} style={({ pressed }) => [styles.add, (disabled || !available) && { opacity: .5 }, pressed && { backgroundColor: theme.soft }]}>
      {imageUrl&&!failed&&<Image source={{uri:imageUrl}} accessibilityLabel={`รูป ${name}`} resizeMode="cover" onError={()=>setFailed(true)} style={{width:'100%',height:90,borderRadius:10}}/>}<Text style={styles.name}>{name}</Text><View style={styles.bottom}><Text style={styles.price}>{price}</Text><Text style={styles.plus}>＋</Text></View>{!available && <Text style={styles.category}>ไม่พร้อมขาย</Text>}
    </Pressable>
  </View>;
}
const styles = StyleSheet.create({
  card: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 16, padding: 12, minHeight: 150 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 4 },
  category: { fontSize: 12, color: theme.muted, flexShrink: 1 },
  star: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  starText: { color: theme.strong, fontSize: 24 },
  add: { minHeight: 90, borderRadius: 10, justifyContent: 'space-between', gap: 10 },
  name: { fontSize: 18, lineHeight: 26, fontWeight: '600', color: theme.text },
  bottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 4, flexWrap: 'wrap' },
  price: { fontSize: 17, color: theme.strong, fontWeight: '700' },
  plus: { color: theme.strong, backgroundColor: theme.soft, fontSize: 24, borderRadius: 8, paddingHorizontal: 6 },
});
