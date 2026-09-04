import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("mobile store submission readiness", () => {
  it("targets Android 16 with a compatible Android Gradle plugin", () => {
    const variables = source("mobile/android/variables.gradle");
    const gradle = source("mobile/android/build.gradle");

    expect(variables).toMatch(/compileSdkVersion\s*=\s*36/);
    expect(variables).toMatch(/targetSdkVersion\s*=\s*36/);
    expect(gradle).toContain("com.android.tools.build:gradle:8.9.1");
  });

  it("uses a new native release version on both platforms", () => {
    const android = source("mobile/android/app/build.gradle");
    const ios = source("mobile/ios/App/App.xcodeproj/project.pbxproj");
    const mobilePackage = JSON.parse(source("mobile/package.json")) as { version: string };

    expect(android).toMatch(/versionCode\s+2/);
    expect(android).toMatch(/versionName\s+["']1\.0\.1["']/);
    expect(ios.match(/CURRENT_PROJECT_VERSION = 2;/g)).toHaveLength(2);
    expect(ios.match(/MARKETING_VERSION = 1\.0\.1;/g)).toHaveLength(2);
    expect(mobilePackage.version).toBe("1.0.1");
  });

  it("declares iOS camera and remote-notification capabilities", () => {
    const info = source("mobile/ios/App/App/Info.plist");
    const project = source("mobile/ios/App/App.xcodeproj/project.pbxproj");
    const entitlements = source("mobile/ios/App/App/App.entitlements");

    expect(info).toContain("<key>NSCameraUsageDescription</key>");
    expect(info).toContain("<key>NSPhotoLibraryUsageDescription</key>");
    expect(info).toMatch(/<key>UIBackgroundModes<\/key>[\s\S]*<string>remote-notification<\/string>/);
    expect(project.match(/CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/g)).toHaveLength(2);
    expect(project).toContain("com.apple.Push");
    expect(entitlements).toContain("<key>aps-environment</key>");
  });

  it("ships an app privacy manifest in the iOS resources phase", () => {
    const project = source("mobile/ios/App/App.xcodeproj/project.pbxproj");
    const privacy = source("mobile/ios/App/App/PrivacyInfo.xcprivacy");

    expect(project).toContain("PrivacyInfo.xcprivacy in Resources");
    expect(privacy).toContain("<key>NSPrivacyTracking</key>");
    expect(privacy).toContain("<key>NSPrivacyCollectedDataTypes</key>");
  });

  it("discloses mobile data use and exposes deletion guidance inside settings", () => {
    const privacy = source("src/app/(legal)/privacy-policy/page.tsx");
    const settingsNav = source("src/app/(dashboard)/settings/SettingsNav.tsx");

    expect(privacy).toContain("Firebase");
    expect(privacy).toContain("ตำแหน่ง");
    expect(privacy).toContain("Bluetooth");
    expect(privacy).toContain("รูปเมนู");
    expect(privacy).toContain("โทเคนอุปกรณ์");
    expect(settingsNav).toContain('href="/account-deletion"');
  });
});
