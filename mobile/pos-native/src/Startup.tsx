import React from 'react';
import { ScrollView, Text, View } from 'react-native';

// Store only diagnostic codes: exception messages can contain credentials or customer data.
const key = 'storeos.startup.diagnostic.v1';
type Diagnostic = { version: string; phase: string; time: string; code: string };
function record(phase: string, error?: unknown): Diagnostic {
  const message = error instanceof Error ? error.message : '';
  const code = message.includes('new NativeEventEmitter()') ? 'NATIVE_EVENT_EMITTER_UNAVAILABLE'
    : message.includes('Cannot find native module') ? 'NATIVE_MODULE_UNAVAILABLE' : 'STARTUP_FAILED';
  const diagnostic = { version: '0.1.5', phase, time: new Date().toISOString(), code };
  try {
    const storage = require('@react-native-async-storage/async-storage').default;
    void storage.setItem(key, JSON.stringify(diagnostic)).catch(() => undefined);
  } catch { /* Diagnostic screen remains available if storage cannot load. */ }
  return diagnostic;
}
function Failure({ diagnostic }: { diagnostic: Diagnostic }) {
  return <View style={{ flex: 1, backgroundColor: '#fff', paddingTop: 70 }}><ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
    <Text style={{ fontSize: 24, color: '#233f34' }}>StoreOS เปิดแอปไม่สำเร็จ</Text>
    <Text>ส่งภาพข้อมูลด้านล่างให้ผู้พัฒนา แล้วปิดและเปิดแอปใหม่ ไม่ต้องลบข้อมูลแอป</Text>
    <Text selectable>{JSON.stringify(diagnostic, null, 2)}</Text>
    <Text>รายละเอียด exception ไม่ถูกเก็บเพื่อป้องกันข้อมูลส่วนตัว รายงาน crash ของระบบอาจมีข้อมูลเพิ่มเติม</Text>
  </ScrollView></View>;
}
let LoadedApp: React.ComponentType | undefined;
let loadFailure: Diagnostic | undefined;
try { LoadedApp = require('../App').default; }
catch (error) { loadFailure = record('load-app-module', error); }
class Boundary extends React.Component<React.PropsWithChildren, { diagnostic?: Diagnostic }> {
  state: { diagnostic?: Diagnostic } = {};
  static getDerivedStateFromError() { return { diagnostic: { version: '0.1.5', phase: 'render', time: new Date().toISOString(), code: 'STARTUP_FAILED' } }; }
  componentDidCatch(error: Error) { this.setState({ diagnostic: record('render', error) }); }
  render() { return this.state.diagnostic ? <Failure diagnostic={this.state.diagnostic} /> : this.props.children; }
}
export function Startup() {
  if (loadFailure) return <Failure diagnostic={loadFailure} />;
  return <Boundary>{LoadedApp ? <LoadedApp /> : null}</Boundary>;
}
