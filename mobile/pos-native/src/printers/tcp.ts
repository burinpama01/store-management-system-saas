export async function sendTcp(_host: string, _port: number, _bytes: Uint8Array): Promise<{ confirmed: boolean }> {
  throw new Error('TCP printing ต้องใช้ native development build บน iOS/Android');
}
