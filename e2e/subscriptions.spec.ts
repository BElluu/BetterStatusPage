import type { AddressInfo } from 'node:net'
import { SMTPServer } from 'smtp-server'
import { STATUS_URL, expect, ok, test, unique } from './fixtures'

const inbox: string[] = []

/** Undo quoted-printable soft breaks and escapes in the body so links can be read back out. */
function decodeMail(raw: string): string {
  const split = raw.indexOf('\r\n\r\n')
  const headers = split < 0 ? raw : raw.slice(0, split)
  const body = split < 0 ? '' : raw.slice(split)
  return headers + body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onData(stream, _session, callback) {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => { inbox.push(decodeMail(Buffer.concat(chunks).toString())); callback() })
  },
})

test.beforeAll(async () => {
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve))
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => smtp.close(() => resolve()))
})

async function nextMail(to: string, matching: RegExp): Promise<string> {
  let found: string | undefined
  await expect.poll(() => {
    found = inbox.find((mail) => mail.includes(to) && matching.test(mail))
    return !!found
  }, { timeout: 15_000, message: `no mail to ${to} matching ${matching}` }).toBe(true)
  return found!
}

function linkFrom(mail: string, kind: 'confirm' | 'manage'): string {
  const match = mail.match(new RegExp(`(https?://[^\\s"<>]+#subscription=${kind}&(?:amp;)?token=[A-Za-z0-9_%-]+)`))
  expect(match, `no ${kind} link in mail`).toBeTruthy()
  return match![1]!.replace('&amp;', '&')
}

test('a visitor subscribes by email, confirms, gets incident mail and unsubscribes', async ({ page, adminApi }) => {
  const { port } = smtp.server.address() as AddressInfo
  await ok(adminApi.put('admin/notifications/smtp', {
    data: { host: '127.0.0.1', port, secure: 0, user: '', password: '', fromAddress: 'status@example.test', fromName: 'E2E Status' },
  }))
  await ok(adminApi.put('admin/subscribers/settings', { data: { enabled: true, allowEmail: true } }))

  const email = `reader-${Date.now()}@example.test`
  await page.goto(STATUS_URL)
  await page.getByRole('button', { name: 'Subscribe' }).click()
  await page.getByRole('button', { name: /^Email/ }).click()
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Subscribe', exact: true }).last().click()
  await expect(page.getByText(/check your inbox/i)).toBeVisible()

  // Links from the email open in a fresh tab, as they would from a mail client.
  const confirmTab = await page.context().newPage()
  await confirmTab.goto(linkFrom(await nextMail(email, /subscription=confirm/), 'confirm'))
  await expect(confirmTab.getByText(/Your subscription is confirmed/)).toBeVisible()
  await confirmTab.close()
  const manageLink = linkFrom(await nextMail(email, /subscription=manage/), 'manage')

  // A new incident reaches the confirmed subscriber.
  const title = unique('Login outage')
  await ok(adminApi.post('admin/incidents', { data: { title, status: 'investigating', impact: 'major', monitorIds: [], notifySubscribers: true } }))
  await nextMail(email, new RegExp(title))

  // The manage link from the email lets the reader leave.
  const manageTab = await page.context().newPage()
  await manageTab.goto(manageLink)
  await manageTab.getByRole('button', { name: 'Unsubscribe' }).click()
  await manageTab.getByRole('button', { name: 'Yes, unsubscribe' }).click()
  await expect(manageTab.getByText(/You have been unsubscribed/)).toBeVisible()

  const mailsBefore = inbox.filter((mail) => mail.includes(email)).length
  const after = unique('After unsubscribe')
  await ok(adminApi.post('admin/incidents', { data: { title: after, status: 'investigating', impact: 'minor', monitorIds: [], notifySubscribers: true } }))
  // Give the notifier a moment, then make sure nothing else arrived for this reader.
  await page.waitForTimeout(2_000)
  expect(inbox.filter((mail) => mail.includes(email)).length).toBe(mailsBefore)
})
