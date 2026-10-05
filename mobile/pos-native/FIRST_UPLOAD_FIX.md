# Codemagic first upload — v0.1.4

5 ตุลาคม 2026 · ต่อจาก config TestFlight v0.1.3

## อาการและหลักฐาน
ภาพ build Index2/commitc931fe0 แสดงว่า CLI แจ้ง `Did not find latest build for app 6819038725` แล้ว Node validation หยุดด้วย `Apple latest build number must be a non-negative integer` ก่อน prebuild เป็นกรณีแอปยังไม่มี build บน Apple ไม่ใช่หลักฐานว่า signing หรือ upload ล้ม

## การแก้
- เก็บ stderrของคำสั่ง queryไว้ชั่วคราว เมื่อCLIexitไม่สำเร็จให้หยุด ไม่ใช้baselineแทนAPI/auth error
- เมื่อCLIสำเร็จและstdoutว่าง ต้องพบข้อความไม่มีbuildตรงAppleIDอย่างครบถ้วนในstderr จึงให้latest=0แล้วใช้max(projectcounter+1, latest+1, localbuildbaseline)
- ไม่รับค่าว่างที่ไม่มีข้อความยืนยัน ไม่รับข้อความของแอปอื่นหรือค่าที่ไม่ใช่ตัวเลข ตัดANSIสีจากข้อความก่อนเทียบ
- Versionapp/package/lockเป็น0.1.4และbaselinebuildNumber4 publishinguploadonly/reviewflagsไม่เปลี่ยน

## Verification
- Regression testจากlogภาพล้มก่อนแก้และผ่านหลังแก้
- TypeScript, native27tests, Expo dependency check, YAML/version一致และBashsyntaxผ่าน
- Testsตรวจfirstupload/noevidence/authfailure/ผิดAppleIDรวมprefixคล้ายกัน/สีANSI/เลขcounterและknownApplebuild
- ต้องตรวจผลCodemagicรอบใหม่จริง ยังไม่ถือว่าuploadหรือAppleprocessingสำเร็จ
