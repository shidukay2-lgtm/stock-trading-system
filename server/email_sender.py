"""
Stock Trading System - メール通知スクリプト (server/email_sender.py)
Python 標準ライブラリ (smtplib, email) を使用したセキュアなメール送信
"""

import sys
import json
import smtplib
from email.mime.text import MIMEText
from email.header import Header

def send_email(config, subject, body):
    smtp_host = config.get("smtpHost", "smtp.gmail.com")
    smtp_port = int(config.get("smtpPort", 587))
    smtp_user = config.get("smtpUser", "")
    smtp_pass = config.get("smtpPass", "")
    to_email = config.get("toEmail", "")

    if not to_email:
        return {"success": False, "message": "送信先メールアドレスが設定されていません"}

    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = smtp_user if smtp_user else "highwin-trade-system@local"
    msg["To"] = to_email

    try:
        # TLS 接続
        server = smtplib.SMTP(smtp_host, smtp_port, timeout=10)
        server.ehlo()
        server.starttls()
        server.ehlo()

        if smtp_user and smtp_pass:
            server.login(smtp_user, smtp_pass)

        server.sendmail(msg["From"], [to_email], msg.as_string())
        server.quit()

        return {"success": True, "message": f"{to_email} へのメール送信に成功しました"}
    except Exception as e:
        return {"success": False, "message": f"SMTP送信エラー: {str(e)}"}

if __name__ == "__main__":
    if len(sys.argv) > 1:
        try:
            input_data = json.loads(sys.argv[1])
            res = send_email(
                input_data.get("config", {}),
                input_data.get("subject", "HighWin 通知"),
                input_data.get("body", "")
            )
            print(json.dumps(res, ensure_ascii=False))
        except Exception as e:
            print(json.dumps({"success": False, "message": str(e)}, ensure_ascii=False))
    else:
        print(json.dumps({"success": False, "message": "引数が不足しています"}, ensure_ascii=False))
