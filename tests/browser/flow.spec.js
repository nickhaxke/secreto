import { test, expect } from "@playwright/test";
test("organizer to private reveal, responsive layout and reduced motion", async ({
  page,
  browser,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("Organizer password").fill("secreto-local-only");
  await page.getByRole("button", { name: "Sign in to Secreto" }).click();
  await page.getByRole("button", { name: "New event", exact: true }).click();
  await page
    .getByLabel("Event name")
    .fill("Winter circle " + testInfo.project.name);
  await page.getByLabel("Exchange date").fill("2030-12-25");
  await page.getByRole("button", { name: "Create event", exact: true }).click();
  await page
    .getByRole("button", { name: "Add participants", exact: true })
    .click();
  await page.getByLabel("Participant names").fill("Alex\nJamie\nSam");
  await page
    .locator("#participants-form")
    .getByRole("button", { name: "Add participants" })
    .click();
  const receipt = page.locator(".invite-receipt").first();
  await expect(receipt).toBeVisible();
  const pin = await receipt.locator(".pin-code").innerText();
  const url = await receipt.locator("a").first().getAttribute("href");
  const otherUrl = await page.locator('.invite-receipt').nth(1).locator('a').first().getAttribute('href');
  const whatsapp = await receipt.locator(".share").getAttribute("href");
  expect(whatsapp).toContain("https://wa.me/");
  expect(decodeURIComponent(whatsapp)).toContain(pin);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Draw names", exact: true }).click();
  await page.locator("#confirm-draw").click();
  await expect(page.getByText("Draw complete", { exact: true })).toBeVisible();
  await expect(page.locator(".person")).toHaveCount(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("dashboard.png"),
    fullPage: true,
  });
  const context = await browser.newContext({
    viewport:
      testInfo.project.name === "mobile"
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const participant = await context.newPage();
  await participant.goto(url);
  await participant.getByLabel("Your six-digit PIN").fill(pin);
  await participant.getByRole("button", { name: "Open my invitation" }).click();
  await participant.getByRole("button", { name: "Unwrap my secret" }).click();
  await expect(participant.locator(".recipient")).toBeVisible();
  const recipient = await participant.locator(".recipient").innerText();
  expect(recipient).not.toBe("Alex");
  expect(
    await participant.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await participant.evaluate(() => Object.keys(localStorage).length),
  ).toBe(0);
  await participant.screenshot({
    path: testInfo.outputPath("reveal.png"),
    fullPage: true,
  });
  await participant.reload();
  await participant.getByRole("button", { name: "Unwrap my secret" }).click();
  await expect(participant.locator(".recipient")).toHaveText(recipient);
  await participant.setViewportSize({width:320,height:740});
  expect(await participant.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await participant.goto(otherUrl);
  await expect(participant.getByLabel('Your six-digit PIN')).toBeVisible();
  await expect(participant.locator('.recipient')).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".status.Revealed")).toHaveCount(1);
  expect(errors).toEqual([]);
  await context.close();
});
