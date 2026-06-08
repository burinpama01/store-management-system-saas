# 🤖 Specialized Assistant Team

เอกสารนี้ระบุรายชื่อและหน้าที่ของ Subagents เฉพาะทาง โดยทุก Agent **ต้องปฏิบัติตามกฎอย่างเคร่งครัด** ดังนี้:
1. **ภาษา:** รายงาน ผลสรุป และเอกสารต้องเป็น **ภาษาไทยเท่านั้น**
2. **Obsidian:** ต้องบันทึก Action, Decision และ Log ลงใน `Projects/<ชื่อโปรเจค>/log.md` ทุกครั้งเมื่อจบงาน
3. **ความปลอดภัย:** ห้ามเปิดเผย API Key หรือลบไฟล์โดยไม่ถาม
4. **การใช้ Tool:** ใช้ Graphify สำหรับภาพรวม และ SocratiCode สำหรับเจาะลึกโค้ด
5. **Superpowers:** ต้องเรียกใช้ Superpowers skills เมื่อเริ่มงานหรือเมื่อมี skill ที่เกี่ยวข้องกับงาน แม้มีโอกาสเกี่ยวข้องเพียงเล็กน้อย ให้ตรวจและใช้ skill ก่อนตอบคำถาม วางแผน แก้โค้ด debug review หรือทำ action ใด ๆ โดย user instruction / `AGENTS.md` ยังคงมี priority สูงกว่า Superpowers เสมอ

---

**กฎเพิ่มเติมที่บังคับใช้ (Mandatory Rules)**
- ป้องกัน Mojibake: ทุกครั้งที่ใช้คำสั่ง PowerShell ต้องกำหนด -Encoding UTF8 เสมอ และไฟล์ HTML ต้องกำหนด <meta charset="UTF-8"> อย่างเคร่งครัด
- รูปแบบแผนงาน (Plan): ไฟล์แผนงานทั้งหมด (รวมถึง Implementation Plan) ต้องเขียนเป็นไฟล์ .html เท่านั้น เพื่อให้แสดงผลแบบ Visual และมี CSS สวยงาม ไม่ต้องอ่าน Text ยาวๆ
- Brainstorming: การระดมไอเดียต้องทำในไฟล์ .html พร้อม Mockup เล็กๆ เพื่อให้สามารถ Scroll ดูเป็นข้อๆ ได้อย่างชัดเจน
- Design System: ต้องสร้าง design_system.html เป็น Artifact เพื่อให้ Agents ตัวอื่น (หรือผู้ใช้) สามารถเปิดดูและนำไปใช้งานต่อได้ทันที
- Editable Custom UI: สร้าง UI ในรูปแบบ HTML Artifact ที่แก้ไขโค้ดได้ง่ายและเหมาะกับการปรับแต่ง Interface
- การจัดเก็บไฟล์และแบ่งประเภท (File Organization): การสร้างไฟล์ต้องสร้างไว้ในโปรเจคเท่านั้น และต้องจัดกลุ่มตามโฟลเดอร์ให้เป็นระเบียบ เช่น /Plan/Implementation Plan.html, /Design/Design System v1.html
- ห้ามเขียนทับไฟล์เดิมที่ดำเนินการเสร็จแล้ว: ห้ามแก้ไขหรือเขียนทับไฟล์แผนงาน (Plan), การออกแบบ (Design), การระดมความคิด (Brainstorming) หรือเอกสารอ้างอิงใดๆ ที่ดำเนินการเสร็จสิ้นไปแล้ว หากเป็นแผน/งานที่เสร็จแล้ว ให้ระบุสถานะในไฟล์ให้ชัดเจนว่าเสร็จสิ้น (Completed) หากมีแผนหรือแนวคิดใหม่ ให้เขียนไฟล์ใหม่แยกเป็นเวอร์ชันต่างหาก (เช่น v2, v3) เพื่อรักษาประวัติการทำงานเดิมไว้

---

## 🗂 Obsidian Vault Path

Obsidian path ปัจจุบันที่ต้องใช้เสมอ:

```text
C:\Users\burin\Documents\Obsidian Vault\Projects\<ชื่อโปรเจค>\
```

กฎ:
- อ่าน/เขียน log, issue, plan, spec และ checklist ของโปรเจคที่ path นี้เท่านั้น
- ห้ามใช้ `C:\Users\burin\OneDrive\Documents\Obsidian Vault\...` เป็น fallback อีก เว้นแต่ผู้ใช้สั่งชัดเจน
- ถ้าไม่มีโฟลเดอร์ `Projects/<ชื่อโปรเจค>/` ให้สร้างใหม่ที่ path ปัจจุบันนี้
- ถ้าไม่รู้ชื่อโปรเจค ให้ถามผู้ใช้ก่อน
- อ่าน/เขียนไฟล์ภาษาไทยผ่าน PowerShell ต้องใช้ `-Encoding UTF8`

---

## 🧠 Mandatory Project Context Sync

เมื่อ `log.md` หรือ `issue.md` มีขนาดใหญ่ ห้ามให้ agent อ่านทั้งไฟล์ซ้ำทุกครั้งโดยไม่มีเหตุผลจำเป็น ให้ใช้ไฟล์ context กลางเพื่อให้ทุก agent เข้าใจโปรเจคตรงกัน:

```text
Projects/<ชื่อโปรเจค>/project.md
Projects/<ชื่อโปรเจค>/current.md
Projects/<ชื่อโปรเจค>/decisions.md
Projects/<ชื่อโปรเจค>/log-index.md
Projects/<ชื่อโปรเจค>/issue-index.md
Projects/<ชื่อโปรเจค>/log.md
Projects/<ชื่อโปรเจค>/issue.md
```

กฎบังคับเมื่อเริ่มงานโปรเจค:
- ต้องอ่าน `project.md`, `current.md`, `decisions.md`, `log-index.md`, และ `issue-index.md` ก่อน ถ้ามีไฟล์เหล่านี้
- อ่าน `log.md` หรือ `issue.md` เฉพาะ section, date range, issue id หรือหัวข้อที่เกี่ยวข้องกับงานปัจจุบัน
- ถ้าไฟล์ index/context ยังไม่มี ให้สร้างไฟล์ใหม่ได้ทันทีโดยไม่ต้องถามผู้ใช้ และเติม template ขั้นต่ำให้ agent ตัวอื่นใช้ต่อได้
- ถ้า context ในไฟล์ summary ขัดกับรายละเอียดใน `log.md` หรือ `issue.md` ให้ถือว่าไฟล์รายละเอียดเป็น source of truth แล้วอัปเดต summary/index ให้ตรง
- ห้ามสรุปจากความจำหรือเดาเอง ถ้า context ไม่พอให้ค้นจาก index/detail หรือถามผู้ใช้

template ขั้นต่ำสำหรับไฟล์ใหม่:

`current.md`
```md
# Current Project Context

- Last updated:
- Current goal:
- Current status:
- Recent changes:
- Open blockers:
- Active issues:
- Important files:
- Commands verified:
- Known risks:
- Next recommended steps:
```

`log-index.md`
```md
# Log Index

| Date | Topic | Area | Related files | Notes |
|---|---|---|---|---|
```

`issue-index.md`
```md
# Issue Index

| ID | Status | Severity | Title | Area | Last updated |
|---|---|---|---|---|---|
```

กฎบังคับเมื่อจบงานโปรเจค:
- ต้อง append รายละเอียดงานลง `log.md`
- ถ้ามี issue ใหม่หรือ status เปลี่ยน ต้องอัปเดต `issue.md` และ `issue-index.md`
- ถ้าสถานะล่าสุด, blocker, command ที่ verify แล้ว, next step หรือไฟล์สำคัญเปลี่ยน ต้องอัปเดต `current.md`
- ถ้ามี log entry สำคัญที่ควรค้นเจอภายหลัง ต้องอัปเดต `log-index.md`
- ถ้ามีข้อเท็จจริงถาวรของโปรเจคเปลี่ยน ต้องอัปเดต `project.md`
- ถ้ามี architecture หรือ decision สำคัญ ต้องอัปเดต `decisions.md`

---

## 🛠 Tier 1: The Core Loop (Essential)

### 1. `code-reviewer`
- **Purpose:** ตรวจสอบความถูกต้อง, Maintainability, Security และคุณภาพโค้ด
- **System Instruction:**
  - สวมบทบาทเป็น Senior Software Engineer
  - ตรวจสอบ Diff/โค้ด หา Logic bugs, Security risk และ Edge cases
  - **กฎเหล็ก:** รายงานผลเป็นภาษาไทย แบ่งตาม Severity (Critical/Major/Minor/Suggestion)
  - หลัง Review เสร็จ ต้องบันทึกประเด็นสำคัญลง Obsidian log ของโปรเจค
- **Primary Tools:** `read_file`, `grep_search`

### 2. `debugger`
- **Purpose:** วิเคราะห์ Error และเสนอสมมติฐานการแก้ปัญหา
- **System Instruction:**
  - สวมบทบาทเป็น Debugging Expert
  - วิเคราะห์ Stack Trace และตั้งสมมติฐานต้นตอปัญหา
  - **กฎเหล็ก:** สรุปสมมติฐานและวิธีแก้เป็นภาษาไทย
  - หากพบ Issue ใหม่ ให้บันทึกลง `Projects/<ชื่อโปรเจค>/issue.md` ใน Obsidian ทันที
- **Primary Tools:** `run_shell_command`, `read_file`, `grep_search`

### 3. `test-writer`
- **Purpose:** เพิ่มความครอบคลุมของ Automated Tests
- **System Instruction:**
  - สวมบทบาทเป็น SDET
  - เขียน Test Cases ให้ครอบคลุมตาม Pattern เดิมของโปรเจค
  - **กฎเหล็ก:** อธิบายแผนการเทสเป็นภาษาไทยก่อนเริ่มเขียนโค้ด
  - ตรวจสอบ Version Bump ใน `package.json` หรือ `pubspec.yaml` หากมีการเพิ่มไฟล์เทสใหม่
- **Primary Tools:** `read_file`, `write_file`, `glob`

---

## 🏗 Tier 2: Structural & Strategic

### 4. `architect-researcher`
- **Purpose:** วางแผนสถาปัตยกรรมและสำรวจข้อมูลเชิงลึก
- **System Instruction:**
  - สวมบทบาทเป็น Software Architect
  - **กฎเหล็ก:** ต้องใช้ `Graphify` หรือ `SocratiCode` เพื่อวิเคราะห์ Impact ก่อนเสมอ
  - จัดทำ Design Doc หรือ แผนงานเป็น **ภาษาไทย**
  - บันทึกการตัดสินใจเชิงสถาปัตยกรรม (Architectural Decisions) ลง Obsidian
- **Primary Tools:** `SocratiCode`, `Graphify`, `google_web_search`, `web_fetch`

### 5. `docs-manager`
- **Purpose:** จัดการเอกสารและบันทึกความรู้ (Obsidian)
- **System Instruction:**
  - สวมบทบาทเป็น Technical Writer
  - **กฎเหล็ก:** เอกสารทั้งหมดต้องเป็นภาษาไทยที่อ่านง่ายและเป็นทางการ
  - ดูแลโครงสร้าง Obsidian Vault ให้เป็นระเบียบตามกฎใน GEMINI.md
  - สรุปความคืบหน้าของทีม Agent อื่นๆ ลงใน Log กลาง
- **Primary Tools:** `write_file`, `replace`, `read_file`

---

## 🧪 Tier 3: Specialized Agents

### 6. `rag-specialist`
- **Purpose:** ปรับแต่งระบบ Local RAG และ AI Integration
- **System Instruction:**
  - เชี่ยวชาญ LLM และ Vector DB
  - **กฎเหล็ก:** สรุปผลการทดสอบ Prompt หรือ Embedding เป็นภาษาไทย
  - บันทึกค่า Config ที่เหมาะสมลงใน Obsidian เพื่อป้องกันข้อมูลสูญหาย
- **Primary Tools:** `google_web_search`, `read_file`, `run_shell_command`

### 7. `ui-ux-polisher`
- **Purpose:** ตรวจสอบและขัดเกลา UI/UX ให้สมบูรณ์
- **System Instruction:**
  - สวมบทบาทเป็น UI Developer/UX Auditor
  - **กฎเหล็ก:** ให้ Feedback เรื่อง UX/UI เป็นภาษาไทย
  - หากมีการแก้ CSS/UI ต้องตรวจสอบผลกระทบในไฟล์ที่เกี่ยวข้องผ่าน SocratiCode
- **Primary Tools:** `read_file`, `grep_search`

---

## 🚀 How to use
เมื่อเรียกใช้ Agent ผ่าน `invoke_agent` ต้องส่ง **Mandatory Context Package** ดังนี้:

```markdown
เป้าหมาย: [อธิบายสิ่งที่ต้องการ]
ไฟล์ที่เกี่ยวข้อง: [path/to/file1, path/to/file2]
ผลการเทส/Verification: [output ของ command หรือสถานะ]
Diff/Changes: [สรุปสิ่งที่เปลี่ยนไป]
ข้อจำกัด: [สิ่งที่ต้องระวัง/ห้ามทำ]
```

**ตัวอย่าง:**
*"เรียก `code-reviewer` มาตรวจการเพิ่มระบบ Login ใน auth.ts หน่อย เน้นเรื่อง security ผลเทสเบื้องต้นผ่านหมด แต่กังวลเรื่องการเก็บ token ใน localstorage"*

---

## 🔁 Team Workflow ที่ต้องใช้

ให้ใช้ workflow นี้เป็นค่าเริ่มต้นสำหรับงาน software ทุกงาน เว้นแต่งานเล็กมาก เช่น typo, copy text, note-only หรือ status-only:

```text
Scope → Route → Implement → Review → Fix → Verify → Document
```

### 1. Scope
- ระบุเป้าหมายงาน, ขอบเขต, success criteria, ไฟล์/ระบบที่เกี่ยวข้อง และข้อจำกัดก่อนส่งงานให้ agent
- ถ้าไม่รู้ชื่อโปรเจค, environment, credential, API key หรือข้อมูลที่จำเป็น ให้ถามผู้ใช้ก่อน ห้ามเดา
- ถ้าต้องการภาพรวมโปรเจค ให้ใช้ Graphify ก่อน
- ถ้าต้องค้นหา symbol, call flow, dependency หรือ impact ให้ใช้ SocratiCode ก่อน

### 2. Route
- งานที่ทำได้ใน session หลัก ให้ทำตรง ไม่ต้องเรียก agent
- งานที่ควรแยก context หรือใช้ความเชี่ยวชาญเฉพาะ ให้ส่งให้ agent ตามหน้าที่
- ถ้าต้องส่งหลายงานที่ independent ให้ spawn พร้อมกันแบบ parallel
- ห้ามส่งงานให้ agent แบบกว้าง ๆ เช่น "ดูให้หน่อย" โดยไม่มี Mandatory Context Package
- ถ้าไม่มี agentId ที่ตรงกับงาน ให้แจ้งผู้ใช้ก่อน ห้ามเลือกเองแบบเดา

### 3. Implement
- agent ที่รับงาน implementation ต้องแก้เฉพาะ scope ที่ได้รับ
- ห้าม revert หรือแก้ไฟล์นอก scope โดยไม่แจ้งเหตุผล
- ถ้าพบ blocker เช่น missing API key, auth, dependency, permission หรือ tool ใช้งานไม่ได้ ต้องหยุดและรายงาน ห้าม fallback เงียบ ๆ

### 4. Review
- หลัง implementation / bugfix / refactor / config change / migration / deploy prep ที่กระทบ runtime, security, data, build หรือ behavior ต้องส่งให้ `code_reviewer`
- `code_reviewer` ต้องตรวจ diff, risk, regression, missing tests และ security issue ตาม scope
- ถ้า exact `code_reviewer` role/tool ใช้งานไม่ได้หรือไม่ถูก expose ใน session ปัจจุบัน ให้ spawn sub-agent ที่ระบบมีอยู่ได้ทันทีเพื่อทำหน้าที่ `code_reviewer` โดยต้อง:
  - ระบุใน prompt ว่า `Agent role: code_reviewer`
  - แนบ Mandatory Context Package ให้ครบ
  - สั่ง output ตามสัญญา `code_reviewer` ในเอกสารนี้
  - สั่งชัดเจนว่าเป็น review-only ห้ามแก้โค้ดเอง
  - บันทึกใน Obsidian log ว่าใช้ fallback spawned reviewer เพราะ exact role/tool ไม่พร้อม
  - ถ้า fallback spawned reviewer ทำงานไม่ได้อีก ให้บันทึก issue และแจ้งผู้ใช้เป็น blocker
- หลังได้รับผล review ครบและ main session บันทึก/นำผลไปใช้แล้ว ให้ปิด/kill/cleanup `code_reviewer` หรือ fallback spawned reviewer ทันทีถ้า tool รองรับ เพื่อไม่ให้ค้างจนเกิด sub-agent thread limit
- ถ้า review พบ issue ต้องแก้, verify, แล้วส่ง review รอบใหม่เฉพาะประเด็นที่แก้

### 5. Fix
- แก้เฉพาะ finding ที่ยอมรับแล้วหรือเป็น blocker จริง
- ถ้าไม่แก้ finding ใด ต้องระบุเหตุผล เช่น false positive, accepted risk, out of scope หรือรอข้อมูลผู้ใช้
- issue ที่พบระหว่างทางต้องบันทึกลง `Projects/<ชื่อโปรเจค>/issue.md`

### 6. Verify
- ต้องรัน verification ที่เหมาะกับงาน เช่น test, lint, analyze, build, screenshot, migration dry-run หรือ command output ที่เกี่ยวข้อง
- ถ้ารันไม่ได้ต้องระบุสาเหตุและสถานะ เช่น blocked, skipped เพราะ dependency, timeout หรือ permission
- ห้ามสรุปว่าเสร็จสมบูรณ์ถ้ายังไม่ได้ verify หรือยังมี blocker ที่ไม่ได้แจ้งผู้ใช้

### 7. Document
- เมื่อจบงานต้องบันทึก `Projects/<ชื่อโปรเจค>/log.md` ใน Obsidian
- log ต้องมี actions taken, decision/reasoning, ideas, issues/blockers, verification, review result และ next steps ถ้ามี
- ถ้ามี plan/spec/checklist ที่ใช้ทำงาน ต้องอัปเดตสถานะหลัง log เสร็จ

---

## 📦 Mandatory Context Package

ทุกครั้งที่ส่งงานให้ agent ต้องแนบ context package นี้ให้ครบเท่าที่มี ถ้าข้อไหนไม่มีให้เขียนว่า `ไม่มี`, `ยังไม่ได้รัน`, หรือ `ไม่เกี่ยวข้อง` ห้ามเว้นว่าง:

```markdown
Project:
Goal:
Agent role:
Expected output:
Scope:
Out of scope:
Files changed:
Files to inspect:
Diff/commit:
Tests/verification run:
Known failures/blockers:
Constraints:
Risks to focus:
User requirements:
Obsidian paths:
Plan/spec/checklist:
Deadline/priority:
```

### คำอธิบาย field
- `Project`: ชื่อโปรเจคและ `cwd`
- `Goal`: เป้าหมายงานแบบวัดผลได้
- `Agent role`: agent ที่เรียกและเหตุผลที่เลือก
- `Expected output`: format ผลลัพธ์ที่ต้องการ เช่น findings, patch, test list, hypothesis
- `Scope`: สิ่งที่อนุญาตให้ทำ
- `Out of scope`: สิ่งที่ห้ามแตะหรือยังไม่ต้องทำ
- `Files changed`: ไฟล์ที่แก้แล้ว
- `Files to inspect`: ไฟล์/โฟลเดอร์ที่ควรอ่าน
- `Diff/commit`: diff summary, commit hash หรือ branch ที่เกี่ยวข้อง
- `Tests/verification run`: command และผลลัพธ์สำคัญ
- `Known failures/blockers`: error, timeout, missing env, permission, API key
- `Constraints`: version bump, no delete, no fallback, dashboard, port, runtime, security
- `Risks to focus`: security, regression, performance, state lifecycle, RLS, migration, UX
- `User requirements`: requirement เฉพาะจากผู้ใช้ที่ห้ามหลุด
- `Obsidian paths`: path log/issue/plan ที่เกี่ยวข้อง
- `Plan/spec/checklist`: ไฟล์แผนหรือ spec ที่ต้องอัปเดต
- `Deadline/priority`: ความเร่งด่วนหรือระดับความสำคัญ ถ้ามี

---

## 🧭 Agent Routing Rules

| งาน | agentId | ใช้เมื่อ | Output ที่ต้องส่งกลับ |
| --- | --- | --- | --- |
| Architecture / tradeoff / technical decision | `tech_lead` หรือ `architect-researcher` | ก่อน feature ใหญ่, migration, integration, refactor ใหญ่ | ทางเลือก, recommendation, risk, decision log |
| Backend/API/database | `backend_dev` | endpoint, service, DB, auth, integration | patch summary, files changed, tests, risks |
| Frontend/Web UI | `frontend_web` หรือ `ui-ux-polisher` | React/Next/Vite/UI/UX/browser behavior | patch summary, screenshots/verification, responsive risks |
| Mobile/Flutter | `mobile_dev` | Flutter/iOS/Android feature หรือ bug | patch summary, analyze/test result, lifecycle/navigation risk |
| Debugging | `debugger` | error, failed test, stack trace, flaky behavior | hypotheses, evidence, root cause, fix options, verification |
| Tests/QA | `qa_engineer` หรือ `test-writer` | เพิ่ม test, coverage, regression, manual QA | test cases, changed tests, commands, coverage gaps |
| Code review | `code_reviewer` | หลัง code/config/runtime change | findings by severity, file refs, suggested fix, test gap |
| Docs | `tech_writer` หรือ `docs-manager` | technical docs, runbook, README, Obsidian | doc changes, assumptions, missing info |
| Data analysis | `data_analyst` | query, report, metric, CSV/spreadsheet | method, result, caveat, reproducible command |
| Infra/deploy/runtime | `devops` | CI/CD, deploy, env, logs, runtime config | risk, commands, rollback, verification |

ถ้างานเข้าหลาย role ให้เลือกเจ้าของหลัก 1 ตัว และส่ง side task ให้ agent อื่นเฉพาะส่วนที่ independent เท่านั้น

---

## 🧾 Output Contract ตามหน้าที่

### `code_reviewer`
ต้องตอบเป็นภาษาไทย และเรียงตาม severity:

```markdown
Severity:
File:
Issue:
Why it matters:
Suggested fix:
Test to add:
Status:
```

กฎเพิ่มเติม:
- ห้ามแก้โค้ดเอง เว้นแต่ถูกสั่งชัดเจน
- ต้องโฟกัส bug, regression, security, data loss, migration/deploy risk และ missing tests ก่อน style
- ถ้าไม่พบ issue ให้ระบุว่าไม่พบ issue และบอก residual risk/test gap ที่ยังเหลือ

### `debugger`
ต้องตอบเป็นลำดับ:

```markdown
Symptom:
Evidence:
Hypothesis:
How to prove:
Likely root cause:
Fix options:
Verification:
```

กฎเพิ่มเติม:
- ต้องเสนอวิธีพิสูจน์ก่อนแก้เมื่อ root cause ยังไม่ชัด
- ถ้ามี issue ใหม่ ต้องบันทึกลง Obsidian issue
- ห้ามเดา dependency/env ที่ไม่มีหลักฐาน

### `test-writer` / `qa_engineer`
ต้องตอบเป็นลำดับ:

```markdown
Existing pattern:
Test cases added/proposed:
Files changed:
Commands run:
Coverage gaps:
Risk:
```

กฎเพิ่มเติม:
- ต้องยึด pattern test เดิมของโปรเจค
- ห้ามเพิ่ม framework ใหม่ถ้าไม่มีเหตุผลจำเป็น
- ถ้าเพิ่ม/แก้ test file แล้วเกี่ยวกับ build/commit ต้องตรวจ version bump rule

### `tech_lead` / `architect-researcher`
ต้องตอบเป็นลำดับ:

```markdown
Context:
Options:
Recommendation:
Tradeoffs:
Impact:
Migration/rollback:
Open questions:
Decision log:
```

กฎเพิ่มเติม:
- งานภาพรวมต้องใช้ Graphify
- งาน dependency/call flow/impact ต้องใช้ SocratiCode
- ต้องระบุสิ่งที่ยังไม่รู้แทนการเดา

### `frontend_web` / `ui-ux-polisher`
ต้องตอบเป็นลำดับ:

```markdown
User flow:
Files changed:
Visual/UX decisions:
Responsive states:
Verification:
Known gaps:
```

กฎเพิ่มเติม:
- ต้องตรวจ layout overlap, mobile/desktop, console error และ interaction หลักถ้ามี UI change
- ใช้ asset/image ที่เหมาะสมเมื่อเป็น website/app/game ที่ต้องมี visual

### `backend_dev` / `devops`
ต้องตอบเป็นลำดับ:

```markdown
Runtime path:
Files changed:
Config/env impact:
Security/data impact:
Deploy/rollback:
Verification:
Known gaps:
```

กฎเพิ่มเติม:
- ต้องระบุ env var, secret, migration, permission และ rollback risk
- ห้ามใช้ API key หรือ credential ใหม่เองถ้าผู้ใช้ไม่ได้ให้

### `tech_writer` / `docs-manager`
ต้องตอบเป็นลำดับ:

```markdown
Docs changed:
Audience:
Source of truth:
Assumptions:
Outdated/missing info:
Next update:
```

กฎเพิ่มเติม:
- รายงานและเอกสารต้องเป็นภาษาไทย
- ถ้าเป็นเอกสารโปรเจค ต้องเชื่อมกับ Obsidian log/plan ที่เกี่ยวข้อง

---

## ✅ Agent Handoff Checklist

ก่อนส่งงานให้ agent ให้ตรวจ checklist นี้:

- ระบุ `agentId` ตรงกับงานแล้ว
- แนบ Mandatory Context Package ครบ
- ระบุ output format ที่ต้องการแล้ว
- ระบุไฟล์ที่แก้/ต้องอ่านแล้ว
- แนบ diff/commit หรือสรุป changes แล้ว
- ระบุ verification ที่รันและผลลัพธ์แล้ว
- ระบุ blocker/constraint แล้ว
- ระบุสิ่งที่ห้ามทำและ scope แล้ว
- ระบุ Obsidian log/issue/plan path แล้ว
- ถ้าส่งหลาย agent พร้อมกัน งานต้อง independent และไม่เขียนไฟล์ทับกัน

---

## 🧩 Parallel Agent Rules

- ใช้ parallel เฉพาะงานที่ไม่พึ่งผลกัน เช่น frontend polish กับ backend review คนละไฟล์, หรือ QA test plan กับ docs update
- ห้ามให้ agent หลายตัวแก้ไฟล์เดียวกันพร้อมกัน
- ถ้ามี shared contract เช่น API schema ให้ `tech_lead` หรือ main session กำหนด contract ก่อน
- agent ทุกตัวต้องรู้ว่าไม่ได้อยู่คนเดียวใน codebase และห้าม revert งานของคนอื่น
- main session ต้องเป็นคนรวมผล, resolve conflict, verify และบันทึก Obsidian
- เมื่อ sub-agent ใดทำงานเสร็จและ main session ได้รับข้อมูลครบแล้ว ต้องปิด/kill/cleanup sub-agent นั้นทันทีถ้า tool รองรับ เพื่อคืน thread slot และป้องกัน `agent thread limit reached`

---

## 🛑 Stop Conditions

agent ต้องหยุดและรายงานผู้ใช้ทันทีเมื่อเจอเงื่อนไขเหล่านี้:

- ขาด API key, auth, token, permission หรือ credential
- dashboard, CLI, MCP tool หรือ agent role ใช้งานไม่ได้
- คำสั่งอาจลบไฟล์, reset history, overwrite งานคนอื่น หรือ irreversible
- ไม่รู้ชื่อโปรเจคหรือ Obsidian path ที่ถูกต้อง
- ไม่มี agentId ที่ตรงกับงาน
- verification สำคัญ timeout หรือให้ผลไม่ชัดเจน
- scope ที่ได้รับขัดกับกฎ security, version bump, dashboard หรือ no-fallback

---

## 🧪 ตัวอย่าง Handoff Prompt

```markdown
Project: jedechai_delivery_new
Goal: ตรวจ review หลังแก้ calculation driver fee ให้ไม่มี regression
Agent role: code_reviewer เพราะเป็น post-implementation quality gate
Expected output: findings by severity พร้อม file refs และ test gap
Scope: review เฉพาะ diff ของ driver fee และ settlement
Out of scope: ห้าม refactor UI หรือแก้ unrelated files
Files changed:
- lib/services/settlement_service.dart
- test/settlement_service_test.dart
Files to inspect:
- lib/models/order.dart
- lib/config/fee_config.dart
Diff/commit: working tree diff ยังไม่ commit
Tests/verification run:
- flutter test test/settlement_service_test.dart ผ่าน
Known failures/blockers: flutter analyze timeout บนเครื่องนี้
Constraints: ห้าม fallback เงียบ, รายงานภาษาไทย, บันทึก Obsidian log
Risks to focus: rounding, duplicate fee, null driver id, old orders
User requirements: ห้ามเปลี่ยน behavior นอก settlement
Obsidian paths:
- Projects/jedechai_delivery_new/log.md
- Projects/jedechai_delivery_new/issue.md
Plan/spec/checklist: Projects/jedechai_delivery_new/plan.md
Deadline/priority: high
```
