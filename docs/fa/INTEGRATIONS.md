<p align="center">
  <b>فارسی</b> &nbsp;·&nbsp; <a href="../MODULES.md">English</a>
</p>

<p align="center"><a href="README.md">فهرست راهنمای فارسی</a></p>

# پیکربندی سرویس‌ها

در **Modules** فیلدها را وارد، ماژول را Enable و Save کنید، **Test connection** را اجرا کنید و سپس یک Operation واقعی کم‌خطر را آزمایش کنید. Health سالم فقط Identity و Connectivity را ثابت می‌کند، نه همهٔ Permissionها، Productها، Creditها یا Access tierها.

## WordPress و Chinvat WP Bridge

ماژول داخلی `wordpress` از Core REST برای Post، Page، Media و Taxonomy استفاده می‌کند. افزونهٔ اختیاری [Chinvat WP Bridge](../../wp-plugin/chinvat-bridge/README.md) نسخهٔ `0.2.0` نه Ability دیگر ارائه می‌کند: `chinvat-bridge/options-get`، `chinvat-bridge/options-update`، `chinvat-bridge/theme-list`، `chinvat-bridge/theme-read`، `chinvat-bridge/theme-write`، `chinvat-bridge/rankmath-get`، `chinvat-bridge/rankmath-update`، `chinvat-bridge/plugins-list` و `chinvat-bridge/plugins-toggle`. Risk آن‌ها به `read`، `act` و `dangerous` در Policy چینوات نگاشت می‌شود. Handshake احرازهویت‌شدهٔ افزونه `GET /wp-json/chinvat-bridge/v1/info` است.

در وضعیت فعلی، ماژول TypeScript `wordpress` نه Handshake را بررسی می‌کند و نه این Abilityها را اجرا می‌کند. WordPress Abilities API + MCP Adapter می‌تواند آن‌ها را مستقیم عرضه کند. Extension آیندهٔ Adapter برای Read از `GET /wp-json/wp-abilities/v1/abilities/{name}/run?input[key]=value` و برای Act/Dangerous از `POST .../run` با Body زیر استفاده خواهد کرد:

```json
{"input":{"key":"value"}}
```

Writeها بدون **Developer Mode** در صفحهٔ Settings افزونه (یا Constant سازگار با نسخهٔ قبل، `CHINVAT_BRIDGE_ENABLE`) غیرفعال‌اند. `theme-write`، `options-update` و `plugins-toggle` Toggle جداگانه دارند و پیش‌فرض همه Off است.

**هشدار صریح:** `theme-write` عمداً امکان Remote Code Execution می‌دهد. فقط از Application password مخصوص Admin استفاده کنید؛ MCP را در اختیار Caller نامطمئن قرار ندهید؛ Content نامطمئن را به Agent دارای Write access ندهید. Path/Symlink confinement به Active theme، Atomic rename، اجرای `php -l` پیش از PHP write، Backup محافظت‌شده زیر `wp-content/chinvat-bak/` و Option denylist ریسک را کاهش می‌دهند، اما امنیت مطلق ایجاد نمی‌کنند. نسخهٔ `0.2.0` همچنین Expert overrideهای بسیار پرخطر برای Relax کردن Denylist و غیرفعال‌کردن Backup دارد؛ Option خود افزونه حتی در Expert mode غیرقابل‌نوشتن می‌ماند.

## Telegram

با `@BotFather` Bot بسازید و `botToken` را وارد کنید. به Bot پیام دهید، `get_updates` را اجرا و `chat_id` را در `chatId` ذخیره کنید. دریافت پیام‌های عادی Group نیازمند غیرفعال‌کردن Privacy Mode است.

## WhatsApp

Meta app token و Phone number ID لازم است. خارج از پنجرهٔ 24h باید Template تأییدشده با `send_template` استفاده شود و Recipient باید Opt-in کرده باشد. `401` معمولاً Token، `403` Permission یا Live نبودن App و `400`/`404` Phone number ID را نشان می‌دهد.

## Facebook

`Page ID` و Page access token بلندمدت با `pages_manage_posts` لازم است. انتشار Production روی Pageهای دیگر معمولاً به Meta App Review نیاز دارد. `401` Token، `403` Scope/App Review/Page role و `400` Page ID را بررسی می‌کند.

## Instagram

Account باید Business یا Creator و به Facebook Page متصل باشد. IG Business/Creator account ID و Token لازم است. `publish_photo` به URL عمومی و قابل‌دسترسی تصویر نیاز دارد. `401` Token، `403` Scope و `400` Account type یا Image URL را بررسی می‌کند.

## LinkedIn

محصول **Share on LinkedIn** و OAuth token با `w_member_social` لازم است. `authorUrn` را از Operation `me` بگیرید؛ Profile URL جایگزین آن نیست. `401` Token، `403` Product/Scope و `422` Author URN را بررسی می‌کند.

## X

OAuth 2.0 user token با `tweet.read`، `tweet.write` و `users.read` لازم است. Free tier محدود و Write-limited است؛ `search_recent` حداقل Basic پولی می‌خواهد. `401`/`403` Credential یا Scope و `403`/`429` Access tier یا Rate limit را بررسی می‌کند. سلامت اتصال به معنی داشتن Credit انتشار نیست.

## NVIDIA با `openai-compatible`

`Base URL` را `https://integrate.api.nvidia.com/v1`، `API key` را کلید `nvapi-` از build.nvidia.com و `Default model` را ID دقیق حاصل از `list_models` قرار دهید. کلید مستقیماً به NVIDIA می‌رود و نباید در OpenRouter قرار گیرد. `401` Key، `404` Model ID و `429` Rate limit یا Tier را بررسی می‌کند.
