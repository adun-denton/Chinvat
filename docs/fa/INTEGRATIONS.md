<p align="center">
  <b>فارسی</b> &nbsp;·&nbsp; <a href="../MODULES.md">English</a>
</p>

<p align="center"><a href="README.md">فهرست راهنمای فارسی</a></p>

# پیکربندی سرویس‌ها

در **Modules** فیلدها را وارد، ماژول را Enable و Save کنید، **Test connection** را اجرا کنید و سپس یک Operation واقعی کم‌خطر را آزمایش کنید. Health سالم فقط Identity و Connectivity را ثابت می‌کند، نه همهٔ Permissionها، Productها، Creditها یا Access tierها.

## WordPress و Chinvat WP Bridge

ماژول داخلی `wordpress` نسخهٔ `0.3.1` از Core REST برای Post، Page، Media و Taxonomy استفاده می‌کند. `get_page` محتوای خام قابل‌ویرایش را می‌خواند و `update_page` فقط Fieldهای ارسال‌شده را بدون تغییر Status به‌روزرسانی می‌کند. Create/Update مربوط به Post و Page پارامتر `featured_media` را می‌پذیرند. `upload_media` دقیقاً یکی از `source_url` عمومی یا `content_base64` همراه `filename` و `mime_type` را قبول می‌کند؛ اندازه به ۲۰ MiB محدود است و URLهای Private/Non-routable، Redirect ناامن و MIME نامعتبر رد می‌شوند. برای فایل خصوصی Google Drive، ابتدا Connector احرازهویت‌شده باید Bytes را دریافت و سپس به‌صورت Base64 به Chinvat تحویل دهد. افزونهٔ اختیاری [Chinvat WP Bridge](../../wp-plugin/chinvat-bridge/README.md) نسخهٔ `0.4.2` هجده Ability ارائه می‌کند: ده Ability قبلی و هشت Ability جدید `chinvat-bridge/db-state`، `chinvat-bridge/global-styles-get`، `chinvat-bridge/global-styles-update`، `chinvat-bridge/global-styles-reset`، `chinvat-bridge/template-list`، `chinvat-bridge/template-get`، `chinvat-bridge/template-update` و `chinvat-bridge/template-reset`. Handshake احرازهویت‌شدهٔ `GET /wp-json/chinvat-bridge/v1/info` با `schema_version: 3` اکنون `toggles.db_layer` و هجده Capability/Risk record را گزارش می‌کند.

ماژول TypeScript `wordpress` نسخهٔ `0.3.1` نوزده Operation ثابت ارائه می‌کند: `bridge_info`، ده Mapping قبلی و هشت Operation جدید `bridge_db_state`، `bridge_global_styles_get`، `bridge_global_styles_update`، `bridge_global_styles_reset`، `bridge_template_list`، `bridge_template_get`، `bridge_template_update` و `bridge_template_reset`. قرارداد HTTP براساس Annotation است، نه Risk: Read با GET، Ability دارای `destructive:true` با DELETE و Query، و Writeهای دیگر با POST و Body زیر اجرا می‌شوند:

```json
{"input":{"key":"value"}}
```

این Operationها از Job و Policy معمول چینوات عبور می‌کنند و Risk ثابت `read`، `act` یا `dangerous` خود را حفظ می‌کنند. `health()` وجود Bridge را Best-effort بررسی و در صورت تشخیص، Version و وضعیت Write را اضافه می‌کند؛ نبود Bridge باعث Fail شدن Health مربوط به Core REST نمی‌شود. فهرست `bridge_*` ثابت است و Adapter هر Ability دلخواه را به‌صورت Dynamic کشف نمی‌کند.

Abilities API حتی برای GET بدون Argument به `input` نیاز دارد؛ Adapter در این حالت `?input=` می‌فرستد. Abilityهای Destructive فقط با DELETE اجرا می‌شوند و Body مربوط به DELETE نادیده گرفته می‌شود، بنابراین Scalar inputها با `input[key]=value` در Query می‌روند. Writeهای Content-bearing مانند `theme-write`، `options-update`، `global-styles-update` و `template-update` با POST JSON اجرا می‌شوند. Booleanهای Query-borne باید با REST sanitizer تفسیر شوند.

پیش از Styling، `bridge_db_state` را اجرا کنید تا Active theme، وجود user Global Styles و DB overrideهای Template/Part همراه `has_theme_file` مشخص شود. `bridge_global_styles_get` Config شبیه `theme.json` را می‌خواند؛ `bridge_global_styles_update` با `styles` و `merge` آن را Replace یا Deep-merge می‌کند؛ `bridge_global_styles_reset` پیش‌فرض آن را Trash و با `force:true` حذف دائمی می‌کند. `bridge_template_list` و `bridge_template_get` خروجی Runtime را می‌خوانند که DB در آن بر فایل مقدم است؛ `bridge_template_update` Block markup را ایجاد یا Update می‌کند؛ `bridge_template_reset` Override را حذف و وجود فایل پشتیبان Theme را گزارش می‌کند.

Writeها بدون **Developer Mode** در صفحهٔ Settings افزونه (یا Constant سازگار با نسخهٔ قبل، `CHINVAT_BRIDGE_ENABLE`) غیرفعال‌اند. چهار DB write علاوه بر Permission `edit_theme_options` به Toggle دقیق **DB Layer (Global Styles & Templates)** نیاز دارند و Risk آن‌ها `act` است؛ در Tier `approve` منتظر تأیید می‌مانند. Helper مربوط به Insert فقط وقتی Actor فاقد `unfiltered_html` است KSES را موقتاً Suspend می‌کند؛ Update مربوط به Template override موجود از مسیر عادی `wp_update_post` می‌رود.

`bridge_theme_scaffold_child` یک Child theme سازگار با Block از Theme پایهٔ فعال (`get_template()`، نه Stylesheet فعلی) می‌سازد تا Child-of-child ایجاد نشود. خروجی شامل `style.css` با Header مربوط به `Template:`، یک `theme.json` حداقلی، یک `functions.php` مطمئن و ساخته‌شده توسط خود افزونه، کپی `parts/header.html` و `parts/footer.html` در صورت وجود، و پوشهٔ `templates/` است. چون Block themeها `style.css` مربوط به Child را خودکار بارگذاری نمی‌کنند، فایل تولیدشده `get_stylesheet_uri()` را روی `wp_enqueue_scripts` Enqueue می‌کند. این کد Static و متعلق به افزونه است و با Writer محدودشدهٔ Scaffold نوشته می‌شود، نه مسیر PHP lint مربوط به ورودی Agent در `theme-write`. ورودی‌ها `slug` با پیش‌فرض `{parent}-child`، `name` و `activate` با پیش‌فرض `true` هستند. این یک Scaffold و مقصد مقاوم در برابر Update برای `theme-write` است، نه Clone کامل Theme. Operation از نوع `dangerous` است و در Tier `approve` پیش از ساخت/فعال‌سازی منتظر تأیید انسان می‌ماند.

**هشدار صریح:** `theme-write` عمداً امکان Remote Code Execution می‌دهد. فقط از Application password مخصوص Admin استفاده کنید؛ MCP را در اختیار Caller نامطمئن قرار ندهید؛ Content نامطمئن را به Agent دارای Write access ندهید. اگر PHP CLI یا `proc_open` در دسترس نباشد، `theme-write` همهٔ Writeهای `.php` از طرف Agent را Fail closed رد می‌کند؛ Write فایل‌های غیر-PHP تحت تأثیر نیست. `functions.php` تولیدشده توسط Scaffold ورودی Agent نیست و از این مسیر عبور نمی‌کند. Path/Symlink confinement به Active theme، Atomic rename، اجرای `php -l` پیش از PHP write، Backup محافظت‌شده زیر `wp-content/chinvat-bak/` و Option denylist ریسک را کاهش می‌دهند، اما امنیت مطلق ایجاد نمی‌کنند. Scaffold نیز فقط داخل Directory جدید و مستقیم زیر Theme root می‌نویسد، Path یا Symlink موجود را رد می‌کند، پس از ساخت دوباره `realpath`/`is_link` را بررسی می‌کند، Segmentها و Name نمایشی را اعتبارسنجی می‌کند و فقط Child معتبر با Parent موجود را فعال می‌کند. افزونه Expert overrideهای بسیار پرخطر برای Relax کردن Denylist و غیرفعال‌کردن Backup دارد؛ Option خود افزونه حتی در Expert mode غیرقابل‌نوشتن می‌ماند.

DB-layer primitives اکنون Shipped و در Production آزمایش شده‌اند. Slice بعدی Export/Snapshot-on-approval است: Overrideهای DB خوانده می‌شوند، در Child theme نوشته و در GitHub Commit می‌شوند، سپس DB reset می‌شود تا فایل‌ها Authoritative شوند. Cache purge، Named site targets، Revision/Coherence، `file-write`، `wp-cli`، RankMath sitewide و Install/Update/Delete کامل Pluginها هنوز در Roadmap هستند.

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
