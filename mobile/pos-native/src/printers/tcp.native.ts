import TcpSocket from 'react-native-tcp-socket';
import { validateLanTarget } from '../domain/raster';
export async function sendTcp(host: string, port: number, bytes: Uint8Array): Promise<{ confirmed: boolean }> {
  validateLanTarget(host, port);
  if (!bytes.length || bytes.length > 1048576) throw new Error('ขนาดงานพิมพ์เกินขอบเขต');
  return new Promise((resolve, reject) => {
    let done = false;
    let socket: ReturnType<typeof TcpSocket.createConnection> | undefined;
    const fail = (error: Error) => { if (done) return; done = true; clearTimeout(timer); socket?.destroy(); reject(error); };
    const timer = setTimeout(() => fail(new Error('ไม่ทราบผลการพิมพ์ กรุณาตรวจเครื่องก่อนส่งซ้ำ')), 15000);
    try {
      socket = TcpSocket.createConnection({ host, port, connectTimeout: 8000 }, () => {
        if (done || !socket) return;
        // One write, no retry: a disconnect may happen after some bytes reached paper.
        socket.write(bytes, undefined, error => {
          if (error) { fail(error); return; }
          if (done) return;
          done = true; clearTimeout(timer); socket?.end(); resolve({ confirmed: false });
        });
      });
      socket.on('error', fail);
      socket.on('close', () => { if (!done) fail(new Error('การเชื่อมต่อปิดก่อนยืนยันการส่ง')); });
    } catch (error) { fail(error instanceof Error ? error : new Error('เปิดการเชื่อมต่อไม่สำเร็จ')); }
  });
}
