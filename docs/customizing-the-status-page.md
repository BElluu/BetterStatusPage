# Customizing the status page

The public status page is built from three admin pages: **Page Builder** decides what is on the page and where, **Branding** decides how it looks, and **Localization** decides which languages visitors can read it in. This guide covers all three, plus dark mode and live updates.

| Admin page | What it controls |
| --- | --- |
| **Page Builder** | Monitors, groups, charts, text, dividers and the incident feed, on a three-column grid |
| **Branding** | Site name, logo, layout switches, uptime bar thresholds, colours and custom CSS |
| **Localization** | Languages, the default language and every piece of text on the public page |

All three are open to the `admin`, `operator` and `branding` roles. See [Who can change this](#who-can-change-this).

---

## Page Builder

*Admin → **Page Builder***

The left side is the **Toolbox**, the right side is the canvas. Drag an item from the toolbox onto the canvas, or press its **+** button to add it below everything else on the page.

The canvas is a grid three columns wide. Move a block by its handle (⠿) and resize it horizontally by its right edge, from one to three columns. Heights are fixed: monitors, charts, dividers and the incident feed always take one row, a group grows with the number of items in it, and a text block grows with its content.

Click a block to select it. Its settings appear under **Properties** in the left panel.

### Blocks

| Toolbox item | What it shows on the page | Properties |
| --- | --- | --- |
| **New group** | A titled card that holds monitors and text blocks | **Group name**, **Collapsible**, **Add monitor to group** |
| **Monitors** (one entry per monitor) | A status card for that monitor | **Monitor**, **Card type**, **Uptime bar**, **Uptime bar position**, **Show uptime %**, **Show monitor type** |
| **Text** | A Markdown block | **Name** (only shown in the builder), **Text (Markdown)** |
| **Divider** | A horizontal line | None |
| **Incidents** | Incident cards | **Incident limit** (1–20, default 5), **Filter**: all, active only or resolved only |
| **Charts** (one entry per monitor) | A response-time chart for that monitor | See below |

**Monitor cards.** **Card type** is **Full** (default) or **Compact**. A full card has a 30-day uptime bar that you can switch off or place to the **Right** of the name (default) or **Below** it. With the bar below, **Show uptime %** adds the uptime percentage. A compact card is a single row without the uptime bar. **Show monitor type** adds the monitor type to either kind.

**Charts** are only offered for HTTPS, Ping, database (SQL Server, PostgreSQL, MySQL / MariaDB, MongoDB) and Docker monitors, because the other types have no response time. A chart has:

- **Title (optional)**: leave it empty to use the monitor name.
- **Time range**: last 1, 3, 6, 12 or 24 hours, 2 days or 7 days. Default: 24 hours.
- **Data points**: 20, 30 (default) or 50.
- **Aggregation**: **AVG** (default), **P95** or **MAX** per data point.
- **Chart height**: **S**, **M** (default) or **L**.
- **Fill area under line** (on by default) and **Show monitor type**.

**Text blocks** take Markdown: headings, paragraphs, lists, links. Raw HTML is not rendered.

### Groups

A group holds monitors and text blocks only. To fill a group:

- drag a monitor or a **Text** item from the toolbox onto the group,
- drag a monitor or text block that is already on the canvas onto the group, or
- select the group and pick monitors under **Add monitor to group**.

Inside a group, drag items by their handle to reorder them. Drag an item out of the group and drop it on the canvas to ungroup it. The **×** next to an item removes it from the group.

On the public page, a **Collapsible** group (the default) has a header visitors can click to fold it.

Deleting a group that still holds items asks for confirmation, because its items are deleted with it.

### Which monitors appear

Only monitors you place on the page, as a card or a chart, are public. Every other monitor stays internal: the public API, the live event stream and the incident feed do not mention its name, status or history. An incident linked to both public and internal monitors shows only the public ones.

The overall status headline at the top of the page is calculated from the monitors on the page. Active incidents count towards it only when the page has an **Incidents** block.

A page with nothing on it tells visitors *This page has not been configured yet.*

When a monitor is deleted, it disappears from the public page at once. The next time you open **Page Builder**, its blocks are removed from the canvas and the layout is marked **Unsaved** so you can save the cleaned-up version.

### Saving

There is no draft: **Save** publishes the layout immediately. The button is only active when there are unsaved changes, and the header shows **Unsaved** until you save. Every save is written to the audit log as **Status Page Layout**.

The builder shows the structure of the page, not the finished look. To see the real page, open it, or use the live preview in **Branding**, which renders the saved layout.

On phones (narrower than 768 px) the page drops the grid and stacks every block in a single column, in order from top to bottom and left to right.

---

## Branding

*Admin → **Branding***

The left panel holds the settings, the right side is a **Live preview** of the public page: the saved Page Builder layout with your unsaved branding changes. Nothing reaches visitors until you click **Save branding**. Every change is written to the audit log.

Branding has two modes, switched by **Custom branding**:

| | Custom branding off (default) | Custom branding on |
| --- | --- | --- |
| Colours | Built-in palette | Your 14 colours |
| Dark mode | Visitors can switch between light and dark | One universal theme in your colours, so no light/dark toggle |
| Image logo | **Light mode logo** and **Dark mode logo** | One **Universal logo** |
| Custom CSS | Not applied | Applied |

Site name, logo text, layout switches and uptime bar thresholds apply in both modes.

### Identity

- **Site name**: used as the browser tab title, under the logo in the footer and as the logo's alt text. Default: `Status Page`. It does not replace the logo.
- **Logo**: choose **Image** or **Text**.
  - **Image**: upload JPEG, PNG, GIF or WebP, up to 5 MB. The file type is checked from the file's contents, not its name. With custom branding off you upload a light and a dark variant, and the page shows the one that matches the visitor's mode; with it on, one universal logo. The header shows it up to 40 px high and 200 px wide. Without an uploaded logo, the page shows the BetterStatusPage logo. The **×** next to a logo removes it.
  - **Text**: up to 40 characters, set in the heading font in the header and footer.

The uploaded logo is also used in [subscriber emails](subscriptions.md): the universal logo with custom branding on, the light mode logo otherwise. Without one, emails show the site name as text.

### Layout

| Switch | What it hides when off |
| --- | --- |
| **Page header** | The overall status headline and the monitor count at the top of the page. The top bar with the logo stays. |
| **Footer** | The logo and site name at the bottom of the page |
| **BetterStatusPage link** | The small project link in the bottom-right corner |

All three are on by default.

### Uptime bar

The colour of each day of the 30-day uptime bar comes from the share of successful checks that day:

| Colour | Default |
| --- | --- |
| Operational | ≥ 99.9 % |
| Degraded | ≥ 99 % |
| Partial outage | ≥ 95 % |
| Down | below the partial outage value |

The values apply to every monitor, with or without custom branding. They must be between 0 and 100 and strictly descending, otherwise **Save branding** stays disabled. Failures that have not reached a monitor's failure threshold do not count; see [Alert hygiene](alert-hygiene.md#failure-and-recovery-thresholds).

### Colours

With **Custom branding** on, you can set 14 colours. Each takes a hex value such as `#22c55e`, or `rgb()` / `rgba()`; anything else is rejected.

| Section | Field | Default | CSS variable |
| --- | --- | --- | --- |
| Backgrounds | **Page background** | `#faf8ff` | `--bsp-bg` |
| | **Cards and groups** | `#f2f3ff` | `--bsp-card-bg` |
| | **Elevated elements and tooltips** | `#e2e7ff` | `--bsp-elevated-bg` |
| | **Charts** | `#f2f3ff` | `--bsp-chart-bg` |
| Borders and charts | **Borders** | `#c6c6cd` | `--bsp-card-border` |
| | **Chart grid lines** | `#c6c6cd` | `--bsp-chart-grid` |
| Text | **Primary text** | `#131b2e` | `--bsp-text` |
| | **Secondary text** | `#505f76` | `--bsp-text-muted` |
| Status colors | **Operational** | `#22c55e` | `--bsp-up` |
| | **Down** | `#ba1a1a` | `--bsp-down` |
| | **Degraded** | `#eab308` | `--bsp-degraded` |
| | **Partial outage** (uptime bar) | `#f97316` | `--bsp-partial` |
| Accent | **Primary color and chart line** | `#000000` | `--bsp-primary` |
| | **Accent color** | `#497cff` | `--bsp-accent` |

Status text (as opposed to dots and bars) is mixed towards the primary text colour so it stays readable.

### Custom CSS

With **Custom branding** on, **Open CSS editor** opens a full-screen editor. Changes show in the live preview as you type; **Save branding** applies them. The CSS is added to the public page and to the [private page's](private-status-page.md) sign-in screen as written, with no sanitising, so only give the `branding` role to people you trust with the page's appearance.

Use these classes to target parts of the page:

| Class | Element |
| --- | --- |
| `.bsp-page` | Entire public status page |
| `.bsp-header` | Sticky page header |
| `.bsp-navigation` | Header navigation content |
| `.bsp-content` | Main page content |
| `.bsp-status-banner` | Overall status badge |
| `.bsp-maintenance-banner` | Maintenance notice |
| `.bsp-monitor-card` | Monitor card |
| `.bsp-monitor-name` | Monitor name |
| `.bsp-group-card` | Monitor group |
| `.bsp-group-label` | Group name |
| `.bsp-chart-card` | Chart card and its background |
| `.bsp-chart` | Chart content |
| `.bsp-chart-tooltip` | Chart hover tooltip |
| `.bsp-text-block` | Page Builder markdown block |
| `.bsp-divider` | Page Builder divider |
| `.bsp-incidents-section` | System events section |
| `.bsp-incident-card` | Incident card or history row |
| `.bsp-footer` | Page footer |
| `.bsp-project-link` | BetterStatusPage link |

The colour variables in the table above hold the current palette, for example:

```css
.bsp-monitor-card {
  border-radius: 8px;
  border-color: var(--bsp-accent);
}
```

The page's Content Security Policy limits what CSS can load: images only from the page's own origin or `data:` URLs, and fonts only from the page itself or Google Fonts.

---

## Dark mode

With **Custom branding** off, the public page has a light and a dark appearance. On the first visit it follows the visitor's operating system setting. The sun/moon button in the header switches it, and the choice is remembered in that browser.

With **Custom branding** on, the page uses one universal theme built from your colours, so there is nothing to switch and the toggle is not shown.

---

## Localization

*Admin → **Localization***

Translations cover the public status page, including the subscribe dialog and the private page's sign-in screen. The admin console is English only.

### Languages

A new instance has one language, **English** (`en`), which is the default. Built-in copy ships for two languages:

| Code | Built-in copy |
| --- | --- |
| `en` | English, complete |
| `pl` | Polish, complete |

To add a language, click **Add Language**, enter a **Code** and a **Name**, then **Create Language**. The code is lowercase letters with an optional region, for example `de`, `fr` or `pt-br`. The name is what visitors see in the language menu, so write it in that language (`Deutsch`, `Polski`).

Adding `pl` (or `pl-pl`) gives you the full Polish page straight away. Any other new language starts out showing English until you translate it.

### Translating

Select a language to see every text key on the public page, grouped as **Status Labels**, **Overall Page Status**, **Page Copy**, **Empty States**, **Uptime Bars & Tooltips**, **Incidents**, **Response Time Chart**, **Subscriptions** and **Private Page Sign-in**. Each field shows the text it falls back to as a placeholder. Type a translation and click **Save Changes**.

Some strings contain placeholders such as `{n}` or `{date}`. Keep them in your translation; they are replaced with numbers and dates on the page.

A key without a translation (or with a cleared field) falls back, in this order, to:

1. the language's built-in copy, if it has one (`pl`, `pl-pl`, … use the Polish copy),
2. English,
3. the key name itself.

### Default language and the visitor's choice

**Set as Default** makes a language the one new visitors see. Only one language is the default, and the default cannot be deleted.

When there is more than one language, the header shows a language menu. A visitor's choice is remembered in their browser and wins over the default. If the chosen language is later deleted, they get the default again. The page does not read the browser's language setting.

Deleting a language removes its translations. Adding, renaming, translating, deleting and changing the default are written to the audit log.

---

## Live updates

The public page keeps a [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events) connection to `/api/v1/public/events`. When a monitor on the page changes status, its card updates without a reload. When an incident is created or updated, the page reloads its status and incident data. Status changes of monitors that are not on the page are not sent.

If the connection drops, the page reconnects after two seconds. The server sends a keep-alive message every 30 seconds. As a fallback, the page also reloads its status every five minutes.

Layout and branding changes are not pushed. Visitors with the page open get them when the page next loads its data, for example on reload.

A reverse proxy must not buffer the event stream. The server sends `X-Accel-Buffering: no`; set the proxy options in [Nginx reverse proxy](deployment.md#nginx-reverse-proxy) as well, so updates arrive at once and long-lived connections are not cut.

---

## Who can change this

| Role | Page Builder | Branding | Localization |
| --- | --- | --- | --- |
| **admin** | Yes | Yes | Yes |
| **operator** | Yes | Yes | Yes |
| **branding** | Yes | Yes | Yes |
| **viewer** | No | No | No |

The `branding` role is meant for people who look after the page's appearance without touching monitoring. In the builder they see each monitor's name and type, enough to place it, but not its configuration; the **Monitors**, **Incidents** and **Notifications** pages are not available to them. See [Users and roles](users-and-roles.md).

---

## API

All endpoints are under `/api/v1/admin` and need one of the roles above.

| Endpoint | Purpose |
| --- | --- |
| `GET` / `PUT /layout` | Read or replace the layout tree (`{ "tree": … }`) |
| `GET /layout/monitors` | Monitor id, name and type, for placing monitors |
| `GET` / `PATCH /branding` | Read or update branding; omitted fields are left unchanged |
| `POST /branding/logo`, `/logo/light`, `/logo/dark` | Upload the universal, light or dark logo (multipart, field `file`) |
| `GET` / `POST /locales` | List languages, or add one (`{ "code": "de", "name": "Deutsch" }`) |
| `GET` / `PATCH` / `DELETE /locales/:code` | Read, update (`name`, `translations`) or delete a language |
| `POST /locales/:code/set-default` | Make a language the default |

`PATCH /branding` takes the layout switches (`showHero`, `showFooter`, `showProjectLink`) and `enabled` (custom branding) as `0` or `1`.
