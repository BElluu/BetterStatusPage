<div align="center">

[English](README.md) · **Polski**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/status/public/logo_dark.png">
  <source media="(prefers-color-scheme: light)" srcset="apps/status/public/logo_light.png">
  <img alt="Better Status Page" src="apps/status/public/logo_light.png" width="320">
</picture>

<br />

**Samodzielnie hostowana strona statusu, przy której nie chce się płakać. 🟢**

*Monitoruj swoje usługi. Powiadamiaj zespół. Informuj użytkowników na bieżąco.*
*Bez chmury. Bez abonamentu. Bez dramy.*

**[🌐 Strona projektu](https://betterstatuspage.dev)** · **[🚀 Demo na żywo](https://demo.betterstatuspage.dev/)** · **[📖 Dokumentacja](https://docs.betterstatuspage.dev)**

[![Node.js](https://img.shields.io/badge/Node.js-26+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://typescriptlang.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)](https://fastify.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

## W skrócie 🎤

Znasz to. API pada o 3 w nocy, użytkownicy zaczynają pisać na Twitterze, szef dzwoni, a Twoja strona statusu to... statyczny plik HTML, który ktoś ostatnio aktualizował w 2019 roku i który Comic Sansem głosi „Wszystkie systemy działają".

**BetterStatusPage** to naprawia. To w pełni samodzielnie hostowana platforma do monitoringu i stron statusu, działająca jako **pojedynczy proces Node.js bez żadnych zewnętrznych zależności** — bez Postgresa, bez Redisa, bez Kubernetesa, bez rachunku za SaaS na 200 dolarów miesięcznie. Sklonuj, skonfiguruj, wdróż. Gotowe.

---

## Status wydania

BetterStatusPage jest obecnie w fazie beta. Aktualnym celem jest praktyczne, samodzielnie hostowane wdrożenie dla małych zespołów i prywatnej infrastruktury:

- jeden proces Node.js 26,
- przechowywanie danych w SQLite,
- wdrożenie przez Docker Compose,
- reverse proxy Nginx,
- wbudowane kopie zapasowe i przywracanie offline,
- brak wymaganej zewnętrznej bazy danych, kolejki czy cache.

Z góry dziękuję za zainteresowanie projektem oraz za każdą instalację, test, zgłoszenie błędu i opinię. Wczesne testy w realnych warunkach są szczególnie cenne i bezpośrednio pomogą ukształtować BetterStatusPage w drodze do wersji stabilnej.

Przed wystawieniem instancji produkcyjnej przeczytaj [przewodnik wdrożeniowy](https://docs.betterstatuspage.dev/deployment/) i [przewodnik po kopiach zapasowych](https://docs.betterstatuspage.dev/backup-restore/) *(EN)* oraz [politykę bezpieczeństwa](https://github.com/BElluu/BetterStatusPage/security/policy).

---

## Co potrafi 🚀

Dokumentacja jest po angielsku *(EN)*.

- 🔍 **[Monitory](https://docs.betterstatuspage.dev/monitors/)** — HTTPS (przepływy uwierzytelniania, ostrzeżenia o wygasaniu certyfikatu TLS), Ping / TCP, DNS, SQL Server, PostgreSQL, MySQL / MariaDB, MongoDB, Oracle, Redis, serwery pocztowe (SMTP / IMAP / POP3), SSH, certyfikaty TLS, wygasanie domen, Docker i pasywne heartbeaty przez webhook, z zależnościami między nimi, oraz [alert „wolniej niż zwykle”](https://docs.betterstatuspage.dev/monitors/#slower-than-usual-alert), gdy p95 czasu odpowiedzi monitora skoczy względem jego własnych ostatnich 7 dni
- 🔔 **[Powiadomienia](https://docs.betterstatuspage.dev/notification-channels/)** — email, webhook, [Slack](https://docs.betterstatuspage.dev/slack-integration/), [Discord](https://docs.betterstatuspage.dev/discord-integration/), [Microsoft Teams](https://docs.betterstatuspage.dev/teams-integration/), [Telegram](https://docs.betterstatuspage.dev/telegram-integration/), ntfy i Pushover, z szablonami i automatycznymi ponowieniami
- 🤫 **[Higiena alertów](https://docs.betterstatuspage.dev/alert-hygiene/)** — progi awarii, godziny ciszy, limity i grupowanie, żeby alertów nikt nie wyłączał
- 🎬 **[Akcje](https://docs.betterstatuspage.dev/actions/)** — wysłanie żądania HTTP, gdy monitor przez dłuższy czas nie działa albo wraca do życia
- 🎨 **[Kreator strony metodą przeciągnij i upuść](https://docs.betterstatuspage.dev/customizing-the-status-page/)** — układ, branding, tryb ciemny i tłumaczenia bez CSS
- 📢 **[Incydenty i okna serwisowe](https://docs.betterstatuspage.dev/incidents-and-maintenance/)** — waga, aktualizacje, powiązane monitory, okna cykliczne
- 📬 **[Subskrypcje](https://docs.betterstatuspage.dev/subscriptions/)** — email, webhook, RSS/Atom i JSON-owe API statusu dla odbiorców
- 🔒 **[Prywatne strony statusu](https://docs.betterstatuspage.dev/private-status-page/)** i 🛟 **[statyczna kopia zapasowa](https://docs.betterstatuspage.dev/static-fallback/)**, dzięki której strona działa mimo awarii serwera
- 📊 **[Raporty dostępności](https://docs.betterstatuspage.dev/reports/)** — dowolny zakres dat, eksport CSV do przeglądów SLA
- 🔐 **[Sejf sekretów](https://docs.betterstatuspage.dev/vault/)** (AES-256-GCM, opcjonalnie HashiCorp Vault), **[SSO](https://docs.betterstatuspage.dev/single-sign-on/)** przez OpenID Connect, **[użytkownicy, role i 2FA](https://docs.betterstatuspage.dev/users-and-roles/)** oraz dziennik audytu każdej zmiany
- 🧩 **[Tokeny API](https://docs.betterstatuspage.dev/api/)**, **[konfiguracja jako kod](https://docs.betterstatuspage.dev/configuration-as-code/)** (YAML) i **[kopie zapasowe](https://docs.betterstatuspage.dev/backup-restore/)**
- ⚡ **Czas rzeczywisty** — zmiany statusu trafiają do panelu i na stronę publiczną przez Server-Sent Events, bez odświeżania

---

## Szybki start produkcyjny

Zalecaną ścieżką wdrożenia jest Docker Compose z opublikowanym obrazem z GHCR. Klonowanie repozytorium nie jest potrzebne — serwer potrzebuje tylko plików `docker-compose.yml` i `.env`.

Na serwerze z Linuksem, Dockerem i Docker Compose v2:

```bash
curl -fsSL https://betterstatuspage.dev/install.sh | sh
```

Skrypt pobiera `docker-compose.yml` i `.env.example`, generuje `JWT_SECRET` i `VAULT_ENCRYPTION_KEY`, pobiera obraz i uruchamia kontener na `127.0.0.1:3000`. Instaluje do `/opt/bsp` jako root, a w pozostałych przypadkach do `~/bsp` (zmienisz to przez `BSP_DIR`). Można go bezpiecznie uruchomić ponownie: istniejący `.env` nigdy nie jest nadpisywany. Zachowaj kopię `VAULT_ENCRYPTION_KEY` — kopie zapasowe jej nie zawierają. Wolisz widzieć każdy krok? Zrób to ręcznie:

```bash
mkdir -p /opt/bsp && cd /opt/bsp
curl -fsSLO https://raw.githubusercontent.com/BElluu/BetterStatusPage/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/BElluu/BetterStatusPage/main/.env.example -o .env
chmod 600 .env
```

Edytuj `.env` i ustaw co najmniej:

```env
BSP_IMAGE=ghcr.io/belluu/better-status-page:0.7.0
JWT_SECRET=<losowy sekret, min. 32 znaki>
VAULT_ENCRYPTION_KEY=<64-znakowy klucz hex>
```

Wygeneruj bezpieczne wartości (uruchom dwa razy, po jednym dla każdego sekretu):

```bash
openssl rand -hex 32
```

Uruchom aplikację:

```bash
docker compose pull
docker compose up -d
```

Otwórz `http://your-server:3000/admin`, by przejść konfigurację początkową. Przy wdrożeniach wystawionych do internetu postaw przed aplikacją Nginx/SSL i nie wystawiaj publicznie portu aplikacji. Zobacz [docs.betterstatuspage.dev/deployment](https://docs.betterstatuspage.dev/deployment/) *(EN)*.

---

## Rozwój projektu

Wymagane: Node.js 26.10+ i npm 11+.

```bash
git clone https://github.com/BElluu/BetterStatusPage.git
cd BetterStatusPage
npm install
npm run dev   # API :3000, panel :5173, strona statusu :5174
```

Architektura, kontrola jakości (`npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e`), struktura projektu i zasady współtworzenia są w [przewodniku dla deweloperów](https://docs.betterstatuspage.dev/development/) *(EN)*.

---

## Licencja

MIT — rób, co chcesz. Tylko błagamy, nie ustawiaj na stronie statusu Comic Sansa. 😅

---

## ☕ Wsparcie

BetterStatusPage jest całkowicie darmowy i open source. Jeśli uważasz go za przydatny i chcesz wesprzeć dalszy rozwój, dobrowolne darowizny są mile widziane, ale nigdy nie są wymagane!

[![Buy Me A Coffee](https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png)](https://buymeacoffee.com/belluu)

Twoje wsparcie pomaga utrzymać projekt przy życiu i motywuje do dalszej pracy — ale samo używanie BetterStatusPage, testowanie go i dzielenie się opiniami to już wystarczające wsparcie!

---

<div align="center">
  <sub>Napędzane kawą ☕, lekkim niewyspaniem i szczerą nienawiścią do kłamiących stron statusu.</sub>
</div>
