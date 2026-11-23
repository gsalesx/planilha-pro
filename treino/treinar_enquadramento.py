"""
Treino do modelo de enquadramento (CatBoost) com o relatório de ajustes da Planilha Pro.

Roda num container temporário no servidor (rede dokploy-network): baixa o relatório pela
API (só medidas, nenhuma foto), monta as features dos rostos achados, treina 5 regressões
(centro x/y do grupo de rostos no quadro 900×900, largura do grupo, inclinação e largura da
cápsula), compara com a regra atual (medianas) em 20% dos pedidos separados e, por fim,
treina com tudo e grava o modelo na planilha (POST /api/ia/modelo-enquadramento).

As features e a geometria têm que bater 1:1 com server/src/enquadramento-modelo.ts.
"""
import http.cookiejar
import json
import math
import os
import random
import sys
import time
import urllib.request

import numpy as np
from catboost import CatBoostRegressor

API = os.environ.get("PLANILHA_API", "http://planilha-pro-m9si6g:3030/api").rstrip("/")
SENHA = os.environ["IA_SENHA"]
CANVAS = 900.0
FEATURES = [
    "coracao", "aspecto", "n_grupo", "n_bons", "gx0", "gy0", "gx1", "gy1", "gw_rel", "gh_rel",
    "rosto_w", "rosto_cx", "rosto_cy", "inclinacao", "score", "W_k", "H_k",
]

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def chamar(caminho, corpo=None, tentativas=6):
    for t in range(tentativas):
        try:
            dados = None if corpo is None else json.dumps(corpo).encode()
            req = urllib.request.Request(API + caminho, data=dados, headers={"Content-Type": "application/json"})
            with opener.open(req, timeout=120) as r:
                return json.loads(r.read())
        except Exception as e:  # planilha reiniciando etc.
            if t == tentativas - 1:
                raise
            print("tentando de novo", caminho, e, flush=True)
            time.sleep(10)


def girar(x, y, W, H, rot):
    a = math.radians(rot)
    c, s = math.cos(a), math.sin(a)
    W2 = abs(W * c) + abs(H * s)
    H2 = abs(W * s) + abs(H * c)
    dx, dy = x - W / 2, y - H / 2
    return dx * c - dy * s + W2 / 2, dx * s + dy * c + H2 / 2, W2, H2


def grupo(rostos):
    bons = [r for r in rostos if r.get("score", 0) >= 0.6]
    if not bons:
        return bons, []
    maior = max(r["w"] for r in bons)
    return bons, [r for r in bons if r["w"] >= maior * 0.35]


def features(coracao, W, H, rostos):
    bons, ficam = grupo(rostos)
    if not ficam or not W or not H:
        return None, None
    x0 = min(r["x"] for r in ficam)
    y0 = min(r["y"] for r in ficam)
    x1 = max(r["x"] + r["w"] for r in ficam)
    y1 = max(r["y"] + r["h"] for r in ficam)
    p = max(ficam, key=lambda r: r["w"])
    inc = float(p.get("inclinacao", 0) or 0)
    while inc > 180:
        inc -= 360
    while inc < -180:
        inc += 360
    f = [
        1.0 if coracao else 0.0, W / H, len(ficam), len(bons), x0 / W, y0 / H, x1 / W, y1 / H,
        (x1 - x0) / W, (y1 - y0) / H, p["w"] / W, (p["x"] + p["w"] / 2) / W, (p["y"] + p["h"] / 2) / H,
        inc, p.get("score", 0), W / 1000, H / 1000,
    ]
    return f, (x0, y0, x1, y1, len(ficam))


def baixar_relatorio():
    itens, desde = [], 0
    while True:
        r = chamar(f"/ia/relatorio?desde={desde}&limite=2000")
        itens += r["itens"]
        if not r.get("proximo"):
            return itens
        desde = r["proximo"]


def montar_linhas(itens):
    # Última versão de cada (peça, slot) — é o ajuste que valeu.
    ultimo = {}
    for it in itens:
        k = (it["piece_id"], it["slot"])
        if k not in ultimo or it["versao"] > ultimo[k]["versao"]:
            ultimo[k] = it
    linhas, pulos = [], {}

    def pular(m):
        pulos[m] = pulos.get(m, 0) + 1

    for it in ultimo.values():
        a = it.get("ajuste") or {}
        modo = a.get("modo")
        if modo not in ("coracao", "rosto"):
            pular("modo"); continue
        if not a.get("ajustado"):
            pular("sem ajuste salvo"); continue
        rot = float(a.get("rotation") or 0)
        if abs(rot) > 25:
            pular("rotacao grande"); continue
        fonte = it.get("fonte") or {}
        usa_fonte = fonte.get("tipo") not in (None, "original") and (fonte.get("deteccao") or {}).get("scrfd")
        W = fonte.get("largura") if usa_fonte else (it.get("foto") or {}).get("largura")
        H = fonte.get("altura") if usa_fonte else (it.get("foto") or {}).get("altura")
        det = fonte["deteccao"]["scrfd"] if usa_fonte else (it.get("deteccao") or {}).get("scrfd")
        if not W or not H or not det or not det.get("rostos"):
            pular("sem rosto"); continue
        f, g = features(modo == "coracao", W, H, det["rostos"])
        if f is None:
            pular("sem rosto bom"); continue
        x0, y0, x1, y1, n = g
        gx, gy, W2, H2 = girar((x0 + x1) / 2, (y0 + y1) / 2, W, H, rot)
        if a.get("width"):
            s = float(a["width"]) / W2
        elif a.get("height"):
            s = float(a["height"]) / H2
        else:
            pular("sem largura"); continue
        alvo = {
            "cx": CANVAS / 2 + float(a.get("dx") or 0) + (gx - W2 / 2) * s,
            "cy": CANVAS / 2 + float(a.get("dy") or 0) + (gy - H2 / 2) * s,
            "gw": (x1 - x0) * s,
            "rot": rot,
            "uw": float(a.get("u_width") or 600),
        }
        if not (0 < alvo["gw"] < 3000) or abs(alvo["cx"]) > 3000 or abs(alvo["cy"]) > 3000:
            pular("alvo absurdo"); continue
        pedido = (it.get("pedido") or {}).get("order_key") or str(it["piece_id"])
        linhas.append({"f": f, "alvo": alvo, "modo": modo, "n": min(n, 3), "pedido": pedido})
    return linhas, pulos


def treinar(X, y):
    m = CatBoostRegressor(iterations=400, depth=5, learning_rate=0.05, loss_function="RMSE", verbose=0, random_seed=7)
    m.fit(X, y)
    return m


def metricas(linhas, prev):
    out = {}
    for modo in ("coracao", "rosto", "todos"):
        idx = [i for i, l in enumerate(linhas) if modo == "todos" or l["modo"] == modo]
        if not idx:
            continue
        dist = [math.hypot(prev[i]["cx"] - linhas[i]["alvo"]["cx"], prev[i]["cy"] - linhas[i]["alvo"]["cy"]) for i in idx]
        gwe = [abs(prev[i]["gw"] - linhas[i]["alvo"]["gw"]) / max(1, linhas[i]["alvo"]["gw"]) for i in idx]
        rote = [abs(prev[i]["rot"] - linhas[i]["alvo"]["rot"]) for i in idx]
        bom = [1 for k in range(len(idx)) if dist[k] < 40 and gwe[k] < 0.15]
        out[modo] = {
            "n": len(idx),
            "centro_erro_mediano_px": round(float(np.median(dist)), 1),
            "centro_erro_medio_px": round(float(np.mean(dist)), 1),
            "largura_erro_mediano_pct": round(float(np.median(gwe)) * 100, 1),
            "inclinacao_erro_medio_graus": round(float(np.mean(rote)), 2),
            "dentro_40px_e_15pct": round(100 * len(bom) / len(idx), 1),
        }
        if modo == "rosto":
            ue = [abs(prev[i]["uw"] - linhas[i]["alvo"]["uw"]) for i in idx]
            out[modo]["capsula_erro_medio_px"] = round(float(np.mean(ue)), 1)
    return out


def baseline(treino, teste):
    med = {}
    for modo in ("coracao", "rosto"):
        for n in (1, 2, 3):
            ls = [l for l in treino if l["modo"] == modo and l["n"] == n] or [l for l in treino if l["modo"] == modo]
            med[(modo, n)] = {k: float(np.median([l["alvo"][k] for l in ls])) for k in ("cx", "cy", "gw", "uw")}
    return [{**med[(l["modo"], l["n"])], "rot": 0.0} for l in teste]


def prever_modelos(ms, linhas):
    X = np.array([l["f"] for l in linhas])
    p = {k: ms[k].predict(X) for k in ms}
    return [{k: float(p[k][i]) for k in p} for i in range(len(linhas))]


def ajustar_todos(linhas):
    X = np.array([l["f"] for l in linhas])
    ms = {}
    for k in ("cx", "cy", "gw", "rot"):
        ms[k] = treinar(X, np.array([l["alvo"][k] for l in linhas]))
    rec = [l for l in linhas if l["modo"] == "rosto"]
    ms["uw"] = treinar(np.array([l["f"] for l in rec]), np.array([l["alvo"]["uw"] for l in rec]))
    return ms


def compactar(m, X_check):
    caminho = "/tmp/m.json"
    m.save_model(caminho, format="json")
    with open(caminho) as fh:
        j = json.load(fh)
    arvores = [
        {
            "splits": [{"float_feature_index": s["float_feature_index"], "border": s["border"]} for s in t["splits"]],
            "leaf_values": t["leaf_values"],
        }
        for t in j["oblivious_trees"]
    ]
    sb = j.get("scale_and_bias", [1, [0]])
    pac = {"oblivious_trees": arvores, "scale_and_bias": [sb[0], sb[1] if isinstance(sb[1], list) else [sb[1]]]}
    # Confere o avaliador (o mesmo do TypeScript) contra o predict do CatBoost.
    ref = m.predict(X_check)
    for i, x in enumerate(X_check):
        soma = 0.0
        for t in arvores:
            idx = 0
            for jj, s in enumerate(t["splits"]):
                if x[s["float_feature_index"]] > s["border"]:
                    idx |= 1 << jj
            soma += t["leaf_values"][idx]
        v = pac["scale_and_bias"][0] * soma + pac["scale_and_bias"][1][0]
        if abs(v - ref[i]) > 1e-3:
            raise SystemExit(f"avaliador não bate com o CatBoost: {v} vs {ref[i]}")
    return pac


def main():
    chamar("/login", {"username": "ia", "password": SENHA})
    itens = baixar_relatorio()
    linhas, pulos = montar_linhas(itens)
    print("RELATORIO", json.dumps({"registros": len(itens), "usados": len(linhas), "pulados": pulos}), flush=True)
    if len(linhas) < 200:
        raise SystemExit("poucos dados")

    pedidos = sorted({l["pedido"] for l in linhas})
    random.Random(42).shuffle(pedidos)
    corte = set(pedidos[: int(len(pedidos) * 0.2)])
    treino = [l for l in linhas if l["pedido"] not in corte]
    teste = [l for l in linhas if l["pedido"] in corte]

    ms = ajustar_todos(treino)
    m_modelo = metricas(teste, prever_modelos(ms, teste))
    m_regra = metricas(teste, baseline(treino, teste))
    resultado = {"treino": len(treino), "teste": len(teste), "regra_atual": m_regra, "modelo": m_modelo}
    print("COMPARACAO", json.dumps(resultado, ensure_ascii=False), flush=True)

    final = ajustar_todos(linhas)
    X_check = np.array([l["f"] for l in linhas[:50]])
    pacote = {
        "versao": 1,
        "criadoEm": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "features": FEATURES,
        "modelos": {k: compactar(final[k], X_check) for k in final},
        "metricas": {**resultado, "relatorio": {"registros": len(itens), "usados": len(linhas), "pulados": pulos}},
    }
    print("ENVIO", chamar("/ia/modelo-enquadramento", pacote), flush=True)
    print("FIM", flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        print("ERRO", e, flush=True)
        sys.exit(1)
