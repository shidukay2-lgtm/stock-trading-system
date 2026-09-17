"""
対象銘柄定義 & ファンダメンタルズ情報 (config/symbols.py)
東証グロース・スタンダード・プライムの成長性小型株監視ユニバース
【厳格ルール】100株あたり10万円以下（株価1,000円以下）で購入可能な単元株のみ
"""
from typing import List, Dict, Any

# 監視対象ユニバース（100株<=10万円で購入可能な成長小型株群）
MONITORING_UNIVERSE: List[Dict[str, Any]] = [
    {
        "code": "4477.T",
        "ticker": "4477",
        "name": "BASE",
        "market": "東証グロース",
        "sector": "情報・通信業",
        "sales_growth_rate": "+24.5%",
        "market_cap_approx": "380億円",
        "operating_profit": "黒字化・高成長",
        "description": "個人・小規模事業者向けECプラットフォーム。高成長・低単価小型株。"
    },
    {
        "code": "5026.T",
        "ticker": "5026",
        "name": "トリプルアイズ",
        "market": "東証グロース",
        "sector": "情報・通信業",
        "sales_growth_rate": "+29.4%",
        "market_cap_approx": "85億円",
        "operating_profit": "大幅増益",
        "description": "独自AI画像認識プラットフォーム・顔認証システム。高成長AI小型株。"
    },
    {
        "code": "2158.T",
        "ticker": "2158",
        "name": "FRONTEO",
        "market": "東証グロース",
        "sector": "情報・通信業",
        "sales_growth_rate": "+15.8%",
        "market_cap_approx": "260億円",
        "operating_profit": "黒字化推進中",
        "description": "独自AIエンジン「KIBIT」を展開。リーガルテック・AI創薬で高モメンタム。"
    },
    {
        "code": "7085.T",
        "ticker": "7085",
        "name": "カーブスHD",
        "market": "東証プライム",
        "sector": "サービス業",
        "sales_growth_rate": "+15.2%",
        "market_cap_approx": "820億円",
        "operating_profit": "最高益更新基調",
        "description": "女性向けフィットネスクラブ。安定高収益・10万円以内投資に適合。"
    },
    {
        "code": "7383.T",
        "ticker": "7383",
        "name": "ネットプロHD",
        "market": "東証プライム",
        "sector": "情報・通信業",
        "sales_growth_rate": "+18.2%",
        "market_cap_approx": "410億円",
        "operating_profit": "黒字基調・高成長",
        "description": "国内後払い(BNPL)決済シェアトップ。低位で10万円以内投資に最適。"
    },
    {
        "code": "5246.T",
        "ticker": "5246",
        "name": "ELEMENTS",
        "market": "東証グロース",
        "sector": "情報・通信業",
        "sales_growth_rate": "+38.5%",
        "market_cap_approx": "190億円",
        "operating_profit": "成長加速",
        "description": "生体認証・本人確認AIソリューション。オンライン認証で急速拡大。"
    },
    {
        "code": "5586.T",
        "ticker": "5586",
        "name": "Laboro.AI",
        "market": "東証グロース",
        "sector": "情報・通信業",
        "sales_growth_rate": "+32.1%",
        "market_cap_approx": "140億円",
        "operating_profit": "黒字成長",
        "description": "カスタムAI導入・オーダーメイド開発を手掛ける先端AIベンチャー。"
    },
    {
        "code": "4482.T",
        "ticker": "4482",
        "name": "ユナイト＆グロウ",
        "market": "東証グロース",
        "sector": "情報・通信業",
        "sales_growth_rate": "+18.9%",
        "market_cap_approx": "60億円",
        "operating_profit": "連続増益",
        "description": "中堅中小企業向け情シス部門シェアードSaaS。高ストック収益比率。"
    },
    {
        "code": "7094.T",
        "ticker": "7094",
        "name": "NexTone",
        "market": "東証グロース",
        "sector": "情報・通信業",
        "sales_growth_rate": "+22.8%",
        "market_cap_approx": "88億円",
        "operating_profit": "高収益体質",
        "description": "音楽著作権管理・デジタルコンテンツ流通。JASRACに次ぐ国内第2位。"
    },
    {
        "code": "4476.T",
        "ticker": "4476",
        "name": "AI CROSS",
        "market": "東証グロース",
        "sector": "情報・通信業",
        "sales_growth_rate": "+22.1%",
        "market_cap_approx": "45億円",
        "operating_profit": "増益基調",
        "description": "企業向けSMS配信サービスおよびビジネスチャットツールを展開。"
    },
    {
        "code": "7354.T",
        "ticker": "7354",
        "name": "DmMiX",
        "market": "東証プライム",
        "sector": "サービス業",
        "sales_growth_rate": "+12.5%",
        "market_cap_approx": "180億円",
        "operating_profit": "高配当・安定",
        "description": "ダイレクトマーケティング・営業支援BPO大手。高流動性低位株。"
    },
    {
        "code": "2484.T",
        "ticker": "2484",
        "name": "出前館",
        "market": "東証スタンダード",
        "sector": "サービス業",
        "sales_growth_rate": "+15.0%",
        "market_cap_approx": "210億円",
        "operating_profit": "収益改善",
        "description": "国内最大級のフードデリバリープラットフォーム。知名度と出来高。"
    },
    {
        "code": "3936.T",
        "ticker": "3936",
        "name": "グローバルウェイ",
        "market": "東証スタンダード",
        "sector": "情報・通信業",
        "sales_growth_rate": "+14.2%",
        "market_cap_approx": "50億円",
        "operating_profit": "黒字基調",
        "description": "キャリコネ等のWebメディアとクラウド型システムインテグレーション。"
    },
    {
        "code": "3903.T",
        "ticker": "3903",
        "name": "gumi",
        "market": "東証プライム",
        "sector": "情報・通信業",
        "sales_growth_rate": "+10.5%",
        "market_cap_approx": "80億円",
        "operating_profit": "ゲーム＆Web3",
        "description": "モバイルオンラインゲーム開発およびブロックチェーン/Web3事業。"
    },
    {
        "code": "4436.T",
        "ticker": "4436",
        "name": "ミンカブ",
        "market": "東証グロース",
        "sector": "情報・通信業",
        "sales_growth_rate": "+21.0%",
        "market_cap_approx": "75億円",
        "operating_profit": "メディア収益",
        "description": "「みんなの株式」「株探」等の金融メディアおよび金融情報ソリューション。"
    },
    {
        "code": "5240.T",
        "ticker": "5240",
        "name": "monoAI",
        "market": "東証グロース",
        "sector": "情報・通信業",
        "sales_growth_rate": "+21.5%",
        "market_cap_approx": "35億円",
        "operating_profit": "メタバース開発",
        "description": "仮想空間メタバースプラットフォーム「XR CLOUD」の開発運営。"
    },
    {
        "code": "4487.T",
        "ticker": "4487",
        "name": "スペースマーケット",
        "market": "東証グロース",
        "sector": "情報・通信業",
        "sales_growth_rate": "+17.6%",
        "market_cap_approx": "30億円",
        "operating_profit": "黒字化",
        "description": "あらゆるスペースを時間貸しできるマーケットプレイスを運営。"
    },
    {
        "code": "4016.T",
        "ticker": "4016",
        "name": "MIT HD",
        "market": "東証スタンダード",
        "sector": "情報・通信業",
        "sales_growth_rate": "+14.0%",
        "market_cap_approx": "25億円",
        "operating_profit": "堅調",
        "description": "システムインテグレーション・セキュリティ・情報システム受託。"
    }
]

def get_symbol_by_code(code: str) -> Dict[str, Any]:
    """コードから銘柄情報を取得"""
    clean_code = code.replace(".T", "")
    for s in MONITORING_UNIVERSE:
        if s["ticker"] == clean_code or s["code"] == code or s["code"] == f"{clean_code}.T":
            return s
# 後方互換性エイリアス
GROWTH_SMALL_CAP_SYMBOLS = MONITORING_UNIVERSE

def get_default_symbol_codes() -> List[str]:
    """デフォルト監視銘柄コード一覧を取得"""
    return [s["code"] for s in MONITORING_UNIVERSE]

