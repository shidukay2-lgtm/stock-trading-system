/**
 * HighWin Trade System - マルチチャネル通知マネージャー (web/js/notifier.js)
 * ブラウザデスクトップ通知 / メール通知 / チャット通知 (Discord, Slack, LINE) の統合管理
 */

class NotificationManager {
    constructor() {
        this.storageKey = "highwin_notification_settings";
        this.defaultSettings = {
            browser: {
                enabled: true,
                sound: true
            },
            email: {
                enabled: false,
                smtpHost: "smtp.gmail.com",
                smtpPort: 587,
                smtpUser: "",
                smtpPass: "",
                toEmail: ""
            },
            chat: {
                discordEnabled: true,
                discordWebhook: "https://discord.com/api/webhooks/1551577859389136908/k439dh4UYByMDUW3Cj9rQDDnRzoKGd07DDB5_kweUdDV7-pDHEIbs-Hbd1cb4hLO4s_f",
                slackEnabled: false,
                slackWebhook: "",
                lineEnabled: false,
                lineToken: ""
            },
            events: {
                buySignal: true,
                takeProfit: true,
                stopLoss: true,
                holdingTimeout: true
            }
        };
        this.settings = this.loadSettings();
    }

    /**
     * 設定の読み込み
     */
    loadSettings() {
        try {
            const raw = localStorage.getItem(this.storageKey);
            if (raw) {
                const parsed = JSON.parse(raw);
                const merged = Object.assign({}, this.defaultSettings, parsed);
                if (parsed.chat) {
                    merged.chat = Object.assign({}, this.defaultSettings.chat, parsed.chat);
                    // Webhook URLが空の場合はデフォルトURLを使用
                    if (!merged.chat.discordWebhook) {
                        merged.chat.discordWebhook = this.defaultSettings.chat.discordWebhook;
                        merged.chat.discordEnabled = true;
                    }
                }
                return merged;
            }
        } catch (e) {
            console.error("通知設定読み込みエラー:", e);
        }
        return JSON.parse(JSON.stringify(this.defaultSettings));
    }

    /**
     * 設定の保存
     */
    saveSettings(newSettings) {
        this.settings = Object.assign({}, this.settings, newSettings);
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(this.settings));
            console.log("通知設定を保存しました:", this.settings);
        } catch (e) {
            console.error("通知設定保存エラー:", e);
        }
    }

    /**
     * ブラウザ通知の権限リクエスト
     */
    async requestBrowserPermission() {
        if (!("Notification" in window)) {
            alert("このブラウザはデスクトップ通知に対応していません。");
            return false;
        }

        if (Notification.permission === "granted") {
            return true;
        }

        if (Notification.permission !== "denied") {
            const permission = await Notification.requestPermission();
            return permission === "granted";
        }

        return false;
    }

    /**
     * ブラウザ通知の送信
     */
    sendBrowserNotification(title, body, tag = "highwin-alert") {
        if (!this.settings.browser.enabled) return;

        if ("Notification" in window && Notification.permission === "granted") {
            try {
                const notif = new Notification(title, {
                    body: body,
                    icon: "https://cdn-icons-png.flaticon.com/512/3313/3313936.png",
                    tag: tag,
                    badge: "https://cdn-icons-png.flaticon.com/512/3313/3313936.png"
                });

                notif.onclick = () => {
                    window.focus();
                    notif.close();
                };
            } catch (e) {
                console.error("ブラウザ通知送信エラー:", e);
            }
        }
    }

    /**
     * Discord Webhook 通知の送信
     */
    async sendDiscordNotification(title, description, fields = [], color = 0x00E5FF) {
        if (!this.settings.chat.discordEnabled || !this.settings.chat.discordWebhook) return;

        const payload = {
            username: "HighWin Trade Bot 📈",
            avatar_url: "https://cdn-icons-png.flaticon.com/512/3313/3313936.png",
            embeds: [
                {
                    title: title,
                    description: description,
                    color: color,
                    fields: fields,
                    footer: {
                        text: "HighWin_TripleConfluence | 東証小型成長株 スイングシステム"
                    },
                    timestamp: new Date().toISOString()
                }
            ]
        };

        try {
            await fetch(this.settings.chat.discordWebhook, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            console.log("Discord通知送信完了");
            return { success: true };
        } catch (e) {
            console.error("Discord通知エラー:", e);
            return { success: false, error: e.message };
        }
    }

    /**
     * Slack Webhook 通知の送信
     */
    async sendSlackNotification(text) {
        if (!this.settings.chat.slackEnabled || !this.settings.chat.slackWebhook) return;

        const payload = {
            text: text,
            username: "HighWin Trade Bot",
            icon_emoji: ":chart_with_upwards_trend:"
        };

        try {
            await fetch(this.settings.chat.slackWebhook, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            console.log("Slack通知送信完了");
            return { success: true };
        } catch (e) {
            console.error("Slack通知エラー:", e);
            return { success: false, error: e.message };
        }
    }

    /**
     * LINE Notify / メール通知（ローカルサーバー経由API）
     */
    async sendServerNotification(type, data) {
        try {
            const res = await fetch(`/api/notify/${type}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data)
            });
            return await res.json();
        } catch (e) {
            console.warn(`サーバー通知 API (${type}) エラー:`, e);
            return { success: false, message: e.message };
        }
    }

    /**
     * テスト通知の送信
     */
    async testNotification(channel) {
        const testTitle = "🔔 【HighWin Trade】通知テスト送信";
        const testMessage = "この通知はHighWin Trade Systemから正常に配信されたテスト通知です。リアルタイムシグナル検知時に同様の通知が届きます。";

        if (channel === "browser") {
            const granted = await this.requestBrowserPermission();
            if (granted) {
                this.sendBrowserNotification(testTitle, testMessage, "test-notif");
                return { success: true, message: "ブラウザ通知を送信しました！" };
            } else {
                return { success: false, message: "ブラウザの通知権限が許可されていません。" };
            }
        }

        if (channel === "discord") {
            if (!this.settings.chat.discordWebhook) {
                return { success: false, message: "Discord Webhook URL が入力されていません。" };
            }
            return await this.sendDiscordNotification(
                testTitle,
                testMessage,
                [
                    { name: "テスト銘柄", value: "カバー (5253.T)", inline: true },
                    { name: "シグナル種別", value: "🔔 BUYシグナル点灯", inline: true },
                    { name: "推奨買値 / 目標", value: "¥1,670 / 利確 +6% (¥1,770)", inline: false }
                ],
                0x00FF88
            );
        }

        if (channel === "slack") {
            if (!this.settings.chat.slackWebhook) {
                return { success: false, message: "Slack Webhook URL が入力されていません。" };
            }
            return await this.sendSlackNotification(`*${testTitle}*\n${testMessage}\n> 銘柄: カバー (5253.T) | 推奨買値: ¥1,670 | 利確+6% 損切-2.5%`);
        }

        if (channel === "email") {
            if (!this.settings.email.toEmail) {
                return { success: false, message: "送信先メールアドレスが入力されていません。" };
            }
            return await this.sendServerNotification("email", {
                config: this.settings.email,
                subject: testTitle,
                body: testMessage
            });
        }

        return { success: false, message: "不明な通知チャネルです。" };
    }

    /**
     * 買いシグナル検知時のマルチチャネル一括配信
     */
    async notifyBuySignal(info, latest, orderCalc) {
        if (!this.settings || !this.settings.events || !this.settings.events.buySignal) return;
        if (!info || !latest) return;

        const signalTime = latest.time || new Date().toISOString().replace("T", " ").substring(0, 16);
        const title = `🔔 【買いシグナル点灯】${info.name} (${info.code}) [${signalTime}]`;
        const orderNote = (orderCalc && orderCalc.note) ? orderCalc.note : "100株";
        const orderInvest = (orderCalc && orderCalc.investment) ? `¥${orderCalc.investment.toLocaleString()}` : "10万円以内";
        const tpStr = latest.takeProfitPrice ? `¥${Number(latest.takeProfitPrice).toFixed(1)}` : `¥${(latest.close * 1.06).toFixed(1)}`;
        const slStr = latest.stopLossPrice ? `¥${Number(latest.stopLossPrice).toFixed(1)}` : `¥${(latest.close * 0.975).toFixed(1)}`;
        const body = `点灯日時: ${signalTime} (1h足確定)\n推奨買値: ¥${latest.close.toLocaleString()} | 推奨株数: ${orderNote} (${orderInvest})\n利確: ${tpStr} (+6.0%) | 損切: ${slStr} (-2.5%) | RR比 2.4:1 | 最大3日保有`;

        // 1. ブラウザ通知
        this.sendBrowserNotification(title, body, `buy-${info.code}`);

        // 2. Discord 通知
        if (this.settings.chat.discordEnabled && this.settings.chat.discordWebhook) {
            await this.sendDiscordNotification(
                title,
                `HighWin_TripleConfluence 戦略により、**${info.name} (${info.code})** にて強力な買いシグナルが点灯しました！\n⏰ **点灯日時: ${signalTime} (1h足確定)**`,
                [
                    { name: "点灯日時", value: `${signalTime} (1h足確定)`, inline: true },
                    { name: "市場 / セクター", value: `${info.market || '東証'} / ${info.sector || '成長小型'}`, inline: true },
                    { name: "推奨エントリー価格", value: `¥${latest.close.toLocaleString()}`, inline: true },
                    { name: "推奨株数 (100株単元)", value: `${orderNote} (${orderInvest})`, inline: true },
                    { name: "利確ライン (+6.0%)", value: tpStr, inline: true },
                    { name: "損切ライン (-2.5%)", value: slStr, inline: true },
                    { name: "リスクリワード比", value: "2.40 : 1", inline: true }
                ],
                0x00FF88
            );
        }

        // 3. Slack 通知
        if (this.settings.chat.slackEnabled && this.settings.chat.slackWebhook) {
            await this.sendSlackNotification(
                `*${title}*\n${body}`
            );
        }

        // 4. メール通知
        if (this.settings.email.enabled && this.settings.email.toEmail) {
            await this.sendServerNotification("email", {
                config: this.settings.email,
                subject: title,
                body: `${title}\n\n${body}\n\nダッシュボードURL: http://localhost:3000`
            });
        }
    }

    /**
     * ポジション決済時のマルチチャネル通知配信 (利確・損切・タイムアウト)
     */
    async notifyTradeExit(trade, symbolName = "") {
        if (!trade) return;
        const name = symbolName || trade.symbol_name || trade.symbol;
        const isWin = trade.pnl_amount > 0;
        const isTP = trade.exit_reason === "TAKE_PROFIT";
        const isSL = trade.exit_reason === "STOP_LOSS";

        let eventEmoji = isTP ? "🎯 【利食い達成】" : (isSL ? "🛑 【損切り執行】" : "⌛ 【保有期限決済】");
        const title = `${eventEmoji} ${name} (${trade.symbol}) [損益: ${isWin ? '+' : ''}¥${Math.round(trade.pnl_amount).toLocaleString()} (${isWin ? '+' : ''}${trade.pnl_pct}%)]`;
        const body = `決済日時: ${trade.exit_time || 'たった今'}\n買値: ¥${Number(trade.entry_price).toLocaleString()} ➔ 決済値: ¥${Number(trade.exit_price).toLocaleString()}\n株数: ${trade.shares}株 | 実現損益: ${isWin ? '+' : ''}¥${Math.round(trade.pnl_amount).toLocaleString()} (${trade.pnl_pct}%)\n決済理由: ${trade.notes || trade.exit_reason}`;

        // 1. ブラウザ通知
        this.sendBrowserNotification(title, body, `exit-${trade.symbol}`);

        // 2. Discord 通知
        if (this.settings.chat && this.settings.chat.discordEnabled && this.settings.chat.discordWebhook) {
            await this.sendDiscordNotification(
                title,
                `保有ポジションが決済約定しました。\n**${name} (${trade.symbol})**`,
                [
                    { name: "決済種別", value: trade.exit_reason, inline: true },
                    { name: "実現損益額", value: `${isWin ? '+' : ''}¥${Math.round(trade.pnl_amount).toLocaleString()} (${isWin ? '+' : ''}${trade.pnl_pct}%)`, inline: true },
                    { name: "買値 ➔ 決済値", value: `¥${Number(trade.entry_price).toLocaleString()} ➔ ¥${Number(trade.exit_price).toLocaleString()}`, inline: true },
                    { name: "保有株数", value: `${trade.shares}株`, inline: true },
                    { name: "決済日時", value: `${trade.exit_time}`, inline: true }
                ],
                isWin ? 0x00FF88 : 0xFF5252
            );
        }

        // 3. Slack 通知
        if (this.settings.chat && this.settings.chat.slackEnabled && this.settings.chat.slackWebhook) {
            await this.sendSlackNotification(`*${title}*\n${body}`);
        }
    }
}

// グローバル公開
window.NotificationManager = NotificationManager;
