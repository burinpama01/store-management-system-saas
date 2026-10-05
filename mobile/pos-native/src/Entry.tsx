import React from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
export function Brand({ large = false }: { large?: boolean }) {
  return <View style={[e.brand, large && { flexDirection: 'column' }]}><View style={{ width: large ? 115 : 70, height: large ? 130 : 77, overflow: 'hidden', backgroundColor: '#fff' }}><Image accessibilityLabel="โลโก้ StoreOS" source={require('../assets/storeos-logo.png')} style={{ position: 'absolute', width: large ? 263 : 158, height: large ? 263 : 158, left: large ? -74 : -44, top: large ? -57 : -35 }} resizeMode="contain" /></View><View><Text style={e.brandName}>StoreOS</Text><Text style={e.muted}>ระบบจัดการร้านในมือคุณ</Text></View></View>;
}
export function EntryLayout({ children }: React.PropsWithChildren) {
  return <SafeAreaView style={e.safe}><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={e.scroll}><View style={e.content}>{children}</View></ScrollView></KeyboardAvoidingView></SafeAreaView>;
}
export function EntryButton({ label, onPress, disabled, secondary = false }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [e.button, secondary && e.secondary, (disabled || pressed) && { opacity: .55 }]}><Text style={[e.buttonText, secondary && { color: '#087f8f' }]}>{label}</Text></Pressable>;
}
export function EntryField({ label, ...props }: React.ComponentProps<typeof TextInput> & { label: string }) {
  return <View style={{ gap: 7 }}><Text style={e.label}>{label}</Text><TextInput {...props} accessibilityLabel={label} style={e.input} /></View>;
}
export function SessionLoading() { return <EntryLayout><View style={{ minHeight: 480, justifyContent: 'center', alignItems: 'center', gap: 24 }}><Brand large /><Text style={e.heading}>พร้อมสำหรับวันทำงานของคุณ</Text><ActivityIndicator accessibilityLabel="กำลังเตรียมแอป" color="#087f8f" /><Text style={e.muted}>กำลังเตรียมแอป…</Text></View></EntryLayout>; }
export const e = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f4f8f9' }, scroll: { flexGrow: 1, padding: 24, alignItems: 'center', justifyContent: 'center' }, content: { width: '100%', maxWidth: 540, gap: 16 }, brand: { flexDirection: 'row', alignItems: 'center', gap: 10 }, brandName: { fontSize: 27, fontWeight: '800', color: '#243438' }, heading: { fontSize: 27, fontWeight: '700', color: '#243438', lineHeight: 36 }, muted: { fontSize: 14, lineHeight: 22, color: '#607378' }, label: { fontSize: 14, fontWeight: '600', color: '#243438' }, input: { minHeight: 52, borderWidth: 1, borderColor: '#bbcdd1', borderRadius: 12, padding: 14, backgroundColor: '#fff', color: '#243438', fontSize: 16 }, button: { minHeight: 52, padding: 15, backgroundColor: '#087f8f', borderRadius: 13, justifyContent: 'center', alignItems: 'center' }, secondary: { backgroundColor: '#e7f2f4' }, buttonText: { fontSize: 16, fontWeight: '700', color: '#fff' }, card: { padding: 18, backgroundColor: '#fff', borderWidth: 1, borderColor: '#dbe5e7', borderRadius: 16, gap: 9 }, error: { color: '#a53625', fontSize: 14, lineHeight: 22 }, link: { minHeight: 44, justifyContent: 'center' }, linkText: { color: '#087f8f', fontSize: 14 }, hint: { color: '#607378', fontSize: 12, lineHeight: 20, textAlign: 'center' },
});
