/*!
 * 피클볼 오픈플레이 로테이션 v2.1.0
 * 복식 오픈플레이 대진 배정 · 점수 기록 · 순위 집계
 *
 * (c) 2026 David Doyun Lee <doyundoyun@gmail.com>
 * MIT License
 */

/*
 * engine.js — 순수 함수 스케줄링 / 랭킹 엔진 (DOM 접근 없음, 외부 의존성 0)
 *
 * Public API
 *   buildRound(session, rng?)      다음 라운드 1개 생성. session 을 변경하지 않는다 (SPEC §2.1, §2.2)
 *   commitRound(session, round)    라운드를 session.rounds 에 추가하고 history 를 증분 갱신한다.
 *                                  ※ session 을 **직접 변경(mutate)** 하며 같은 session 객체를 반환한다.
 *   rebuildHistory(session)        rounds 전체로부터 history 를 처음부터 다시 만든다 (교체/재생성 후).
 *   rankPlayers(session)           SPEC §4.1 정렬 + 공동 등수(1,1,3) 배열 반환
 *   playerStats(session)           SPEC §1 파생 통계 { [playerId]: PlayerStat }
 *   validateScore(a, b, cfg)       SPEC §3.2 검증. 통과 시 null, 실패 시 한국어 문자열
 *   availableRounds(player, currentRound)
 *
 * 부가 유틸: pairKey, isEligible, createSession, applyResult(=commitRound alias)
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ══════════════════════════════════════════════
     기본 유틸
     ══════════════════════════════════════════════ */

  /** 정렬된 두 id 로 history 키를 만든다. */
  function pairKey(a, b) {
    return a < b ? a + "|" + b : b + "|" + a;
  }

  /** 라운드 N 에 출전 가능한가. leftRound = n 이면 n 라운드부터 제외. */
  function isEligible(player, roundNo) {
    if (!player) return false;
    if (player.active === false) return false;
    if (player.joinedRound > roundNo) return false;
    if (player.leftRound != null && roundNo >= player.leftRound) return false;
    return true;
  }

  /**
   * SPEC §2.2: availableRounds = min(currentRound, leftRound ?? ∞) - joinedRound + 1
   * leftRound = n 은 "n 라운드부터 제외" 이므로 마지막 출전 가능 라운드는 (leftRound - 1) 이다.
   * 따라서 상한은 min(currentRound, leftRound - 1) 을 쓴다. 음수는 0 으로 자른다.
   */
  function availableRounds(player, currentRound) {
    var last = player.leftRound != null
      ? Math.min(currentRound, player.leftRound - 1)
      : currentRound;
    return Math.max(0, last - player.joinedRound + 1);
  }

  /* ══════════════════════════════════════════════
     통계 (SPEC §1 파생 통계, §4.3 skipped 제외)
     ══════════════════════════════════════════════ */

  /**
   * playerStats(session) → { [id]: PlayerStat }
   *  played        배정된 경기 수 (skipped 포함)
   *  scored        status === "done" 인 경기 수
   *  wins/losses   done 경기만
   *  pointsFor/pointsAgainst  done 경기만
   *  restRounds    availableRounds - played
   *  attendRate    played / max(1, availableRounds)
   *  partnerRepeats 같은 파트너와 2회 이상 만난 초과 횟수 합
   */
  function playerStats(session) {
    var rounds = session.rounds || [];
    var currentRound = rounds.length;
    var out = {};

    session.players.forEach(function (p) {
      out[p.id] = {
        id: p.id,
        name: p.name,
        played: 0,
        scored: 0,
        wins: 0,
        losses: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        restRounds: 0,
        attendRate: 0,
        partnerRepeats: 0,
        lastPlayedRound: 0,
        playedRounds: []
      };
    });

    var partnerCount = {};

    rounds.forEach(function (r) {
      (r.games || []).forEach(function (g) {
        var sides = [
          { team: g.teamA, mine: g.scoreA, theirs: g.scoreB },
          { team: g.teamB, mine: g.scoreB, theirs: g.scoreA }
        ];
        sides.forEach(function (side) {
          var k = pairKey(side.team[0], side.team[1]);
          partnerCount[k] = (partnerCount[k] || 0) + 1;
          side.team.forEach(function (id) {
            var s = out[id];
            if (!s) return;
            s.played += 1;
            s.lastPlayedRound = r.no;
            s.playedRounds.push(r.no);
            if (g.status === "done") {
              s.scored += 1;
              s.pointsFor += side.mine || 0;
              s.pointsAgainst += side.theirs || 0;
              if (side.mine > side.theirs) s.wins += 1;
              else if (side.mine < side.theirs) s.losses += 1;
            }
          });
        });
      });
    });

    Object.keys(partnerCount).forEach(function (k) {
      var extra = partnerCount[k] - 1;
      if (extra <= 0) return;
      k.split("|").forEach(function (id) {
        if (out[id]) out[id].partnerRepeats += extra;
      });
    });

    session.players.forEach(function (p) {
      var s = out[p.id];
      var avail = availableRounds(p, currentRound);
      s.availableRounds = avail;
      s.restRounds = Math.max(0, avail - s.played);
      s.attendRate = s.played / Math.max(1, avail);
    });

    return out;
  }

  /* ══════════════════════════════════════════════
     랭킹 (SPEC §4.1)
     ══════════════════════════════════════════════ */

  function rankCompare(a, b) {
    if (a.wins !== b.wins) return b.wins - a.wins;
    if (a.pointsFor !== b.pointsFor) return b.pointsFor - a.pointsFor;
    if (a.pointsAgainst !== b.pointsAgainst) return a.pointsAgainst - b.pointsAgainst;
    return String(a.name).localeCompare(String(b.name), "ko");
  }

  /** 공동 등수는 같은 등수를 부여하고 다음 등수를 건너뛴다 (1, 1, 3, 4 …). */
  function rankPlayers(session) {
    var stats = playerStats(session);
    var rows = session.players.map(function (p) {
      var s = stats[p.id];
      return {
        id: p.id,
        name: p.name,
        rank: 0,
        played: s.played,
        scored: s.scored,
        wins: s.wins,
        losses: s.losses,
        pointsFor: s.pointsFor,
        pointsAgainst: s.pointsAgainst
      };
    });
    rows.sort(rankCompare);
    for (var i = 0; i < rows.length; i++) {
      if (i > 0 &&
        rows[i].wins === rows[i - 1].wins &&
        rows[i].pointsFor === rows[i - 1].pointsFor &&
        rows[i].pointsAgainst === rows[i - 1].pointsAgainst) {
        rows[i].rank = rows[i - 1].rank;
      } else {
        rows[i].rank = i + 1;
      }
    }
    return rows;
  }

  /* ══════════════════════════════════════════════
     점수 검증 (SPEC §3.2)
     ══════════════════════════════════════════════ */

  function validateScore(a, b, cfg) {
    cfg = cfg || {};
    var winPoint = cfg.winPoint == null ? 11 : cfg.winPoint;
    var winBy2 = cfg.winBy2 !== false;
    if (a === b) return "동점은 저장할 수 없습니다";
    var hi = Math.max(a, b), lo = Math.min(a, b);
    if (hi < winPoint) return winPoint + "점 이상이어야 합니다";
    if (winBy2 && hi - lo < 2) return "2점 차 이상이어야 합니다";
    if (hi > winPoint && hi - lo !== 2) return "듀스는 정확히 2점 차여야 합니다";
    return null;
  }

  /* ══════════════════════════════════════════════
     팀 배정 비용 최소화 (SPEC §2.3)
       cost = 파트너중복 × 10 + 상대중복 × 1 + |팀A 승수합 − 팀B 승수합| × balanceWeight
     ══════════════════════════════════════════════ */

  var NODE_CAP = 400;
  var FULL_ENUM_MAX = 8;   // 이 인원 이하는 배치를 전수 열거한다 (8명 → 105×3 = 315가지)

  function teamCost(A, B, ctx) {
    var c = (ctx.partner(A[0], A[1]) + ctx.partner(B[0], B[1])) * 10;
    for (var x = 0; x < 2; x++) for (var y = 0; y < 2; y++) c += ctx.opponent(A[x], B[y]);
    if (ctx.balanceWeight > 0) {
      c += Math.abs(
        (ctx.wins(A[0]) + ctx.wins(A[1])) - (ctx.wins(B[0]) + ctx.wins(B[1]))
      ) * ctx.balanceWeight;
    }
    return c;
  }

  /** 배치 하나의 파트너 중복 총합 */
  function partnerRepeatsOfGames(games, ctx) {
    var n = 0;
    games.forEach(function (g) {
      n += ctx.partner(g.A[0], g.A[1]) + ctx.partner(g.B[0], g.B[1]);
    });
    return n;
  }

  /**
   * 소규모(≤ FULL_ENUM_MAX)일 때 가능한 모든 배치를 비용과 함께 열거한다.
   * 전수 열거라야 마지막 라운드에서 유일하게 남은 해답을 놓치지 않는다.
   */
  function enumerateArrangements(sel, courtCount, ctx, cleanLimit) {
    var m = sel.length;
    var out = [];
    var used = new Array(m).fill(false);
    var pairs = [];
    var clean = 0;
    var stop = false;
    if (cleanLimit == null) cleanLimit = Infinity;

    function groupPairs() {
      var K = pairs.length;
      var usedP = new Array(K).fill(false);
      var games = [];
      (function rg(cost) {
        if (stop) return;
        if (games.length === courtCount) {
          var snap = games.map(function (g) { return { A: g.A.slice(), B: g.B.slice() }; });
          var pr = partnerRepeatsOfGames(snap, ctx);
          out.push({ games: snap, cost: cost, partnerRepeats: pr });
          if (pr === 0 && ++clean >= cleanLimit) stop = true;
          return;
        }
        var i = 0;
        while (usedP[i]) i++;
        usedP[i] = true;
        for (var j = i + 1; j < K; j++) {
          if (usedP[j]) continue;
          usedP[j] = true;
          var A = pairs[i], B = pairs[j];
          games.push({ A: A, B: B });
          rg(cost + teamCost(A, B, ctx));
          games.pop();
          usedP[j] = false;
        }
        usedP[i] = false;
      })(0);
    }

    (function rec() {
      if (stop) return;
      if (pairs.length === m / 2) { groupPairs(); return; }
      var i = 0;
      while (used[i]) i++;
      used[i] = true;
      for (var j = i + 1; j < m; j++) {
        if (used[j]) continue;
        used[j] = true;
        pairs.push([sel[i], sel[j]]);
        rec();
        pairs.pop();
        used[j] = false;
        if (stop) break;
      }
      used[i] = false;
    })();

    return out;
  }

  /**
   * 선발된 선수(sel, 길이 4k)를 k개 코트의 2:2 로 배치하되 비용이 최소인 조합을 찾는다.
   * 1) 완전 매칭(파트너 쌍) 전수 탐색 + 분기 한정(B&B) + MRV(선택지 적은 선수 우선) 휴리스틱
   * 2) 만들어진 2k개 쌍을 k개 경기로 묶는 방법 전수 탐색 (k=1:1, k=2:3, k=3:15 가지)
   * 비용 0 을 찾으면 즉시 종료한다.
   */
  function bestArrangement(sel, courtCount, ctx) {
    var m = sel.length;
    var K = courtCount * 2;              // 필요한 팀(쌍) 수
    var matched = new Array(m).fill(false);
    var chosen = [];                     // [[i,j], ...] sel 인덱스 쌍
    var best = null, bestCost = Infinity, done = false, nodes = 0;

    function pCost(i, j) {
      return ctx.partner(sel[i], sel[j]) * 10;
    }
    function gameCost(A, B) {
      var c = 0;
      for (var x = 0; x < 2; x++) for (var y = 0; y < 2; y++) c += ctx.opponent(A[x], B[y]);
      if (ctx.balanceWeight > 0) {
        var wa = ctx.wins(A[0]) + ctx.wins(A[1]);
        var wb = ctx.wins(B[0]) + ctx.wins(B[1]);
        c += Math.abs(wa - wb) * ctx.balanceWeight;
      }
      return c;
    }

    function groupPairs(partnerCost) {
      var usedP = new Array(K).fill(false);
      var games = [];
      (function rg(cost) {
        if (done || cost >= bestCost) return;
        if (games.length === courtCount) {
          bestCost = cost;
          best = games.map(function (g) { return { A: g.A.slice(), B: g.B.slice() }; });
          if (bestCost === 0) done = true;
          return;
        }
        var i = 0;
        while (usedP[i]) i++;
        usedP[i] = true;
        for (var j = i + 1; j < K; j++) {
          if (usedP[j]) continue;
          usedP[j] = true;
          var A = [sel[chosen[i][0]], sel[chosen[i][1]]];
          var B = [sel[chosen[j][0]], sel[chosen[j][1]]];
          games.push({ A: A, B: B });
          rg(cost + gameCost(A, B));
          games.pop();
          usedP[j] = false;
          if (done) break;
        }
        usedP[i] = false;
      })(partnerCost);
    }

    (function rec(cost) {
      if (done || cost >= bestCost) return;
      if (chosen.length === K) { groupPairs(cost); return; }
      if (++nodes > NODE_CAP) return;

      // MRV: 최소비용 후보가 가장 적은 선수부터 매칭한다 (막다른 길 회피)
      var pick = -1, pickOpts = null, pickZero = Infinity;
      for (var i = 0; i < m; i++) {
        if (matched[i]) continue;
        var opts = [];
        var zero = 0;
        for (var j = 0; j < m; j++) {
          if (j === i || matched[j]) continue;
          var c = pCost(i, j);
          if (c === 0) zero++;
          opts.push({ j: j, c: c });
        }
        if (zero < pickZero) { pickZero = zero; pick = i; pickOpts = opts; }
        if (zero === 0) break;
      }
      if (pick < 0) return;

      // 후보 정렬: 비용 오름차순 → 후보 자신의 여유 선택지 오름차순
      var freedom = {};
      pickOpts.forEach(function (o) {
        var f = 0;
        for (var j2 = 0; j2 < m; j2++) {
          if (j2 === o.j || j2 === pick || matched[j2]) continue;
          if (pCost(o.j, j2) === 0) f++;
        }
        freedom[o.j] = f;
      });
      pickOpts.sort(function (x, y) { return (x.c - y.c) || (freedom[x.j] - freedom[y.j]); });

      matched[pick] = true;
      for (var k = 0; k < pickOpts.length; k++) {
        var o = pickOpts[k];
        matched[o.j] = true;
        chosen.push([pick, o.j]);
        rec(cost + o.c);
        chosen.pop();
        matched[o.j] = false;
        if (done) break;
      }
      matched[pick] = false;
    })(0);

    return { games: best, cost: bestCost };
  }

  /* ══════════════════════════════════════════════
     라운드 생성 (SPEC §2.1, §2.2)
     ══════════════════════════════════════════════ */

  var MAX_SELECTIONS = 70;   // 한 라운드에서 검토할 선발 조합 수 상한
  var MAX_OPTIONS = 60;      // (선발 × 배치) 후보 검토 수 상한
  var topDepth = 3;          // 이번 buildRound 의 최상위 예측 깊이
  // 한 번의 buildRound 가 쓸 수 있는 예측 재귀 횟수 상한 (성능 예산 보호)
  var WORK_BUDGET = 200;
  var budget = WORK_BUDGET;
  // 인원이 많으면 미사용 파트너 조합이 넉넉해 막다른 길이 생기지 않고,
  // 라운드가 쌓이면 어차피 중복이 불가피하므로 예측 탐색을 끈다 (성능 예산 보호).
  var DEEP_LOOKAHEAD_MAX_PLAYERS = 9;

  function shuffleInPlace(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = (rng() * (i + 1)) | 0;
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** 라운드 N 직전까지의 연속 대기 라운드 수 (출전 가능했는데 쉰 라운드만 센다). */
  function consecutiveWait(player, roundNo, playedSet) {
    var w = 0;
    for (var r = roundNo - 1; r >= player.joinedRound; r--) {
      if (!isEligible(player, r)) break;
      if (playedSet[r]) break;
      w++;
    }
    return w;
  }

  /**
   * buildRound(session, rng?) → 다음 라운드 객체 (session 은 변경하지 않는다)
   * { no, games:[{id, court, teamA, teamB, scoreA:null, scoreB:null, status:"pending"}],
   *   resting:[id...], locked:false }
   */
  function buildRound(session, rng) {
    budget = WORK_BUDGET;
    var N = (session.rounds || []).length + 1;
    var elig = session.players.filter(function (p) { return isEligible(p, N); }).length;
    var courts = Math.min((session.config || {}).courts || 1, Math.floor(elig / 4));
    // 코트가 1면이면 탐색 공간이 작아 깊게 보고, 여러 면이면 얕게 본다 (품질/속도 균형)
    topDepth = elig > DEEP_LOOKAHEAD_MAX_PLAYERS ? 0 : (courts <= 1 ? 3 : 2);
    return buildRoundInternal(session, rng || Math.random, topDepth).round;
  }

  /** 라운드 후보를 확정했다고 가정한 얕은 복제본 (1-ply 예측용). */
  function cloneWithRound(session, round) {
    var clone = {
      version: session.version,
      id: session.id,
      date: session.date,
      config: session.config,
      players: session.players,
      rounds: (session.rounds || []).slice(),
      history: {
        partner: Object.assign({}, (session.history && session.history.partner) || {}),
        opponent: Object.assign({}, (session.history && session.history.opponent) || {})
      }
    };
    return commitRound(clone, round);
  }

  /**
   * depth > 0 이면 후보 라운드를 확정했을 때 **다음 라운드도 파트너 중복 0** 으로
   * 만들 수 있는지 1수 앞을 확인한다. 그리디가 마지막 라운드에서 막다른 길에
   * 빠지는 것을 막아준다 (9명 1코트 9라운드 / 9명 2코트 9라운드에 필수).
   */
  function buildRoundInternal(session, rng, depth) {
    var cfg = session.config || {};
    var balanceWeight = Math.min(1.0, cfg.balanceWeight || 0);
    var rounds = session.rounds || [];
    var N = rounds.length + 1;

    var stats = playerStats(session);
    var playedSets = {};
    session.players.forEach(function (p) {
      var set = {};
      (stats[p.id].playedRounds || []).forEach(function (r) { set[r] = true; });
      playedSets[p.id] = set;
    });

    var eligible = session.players.filter(function (p) { return isEligible(p, N); });
    var courts = Math.min(cfg.courts || 1, Math.floor(eligible.length / 4));

    function emptyRound() {
      return {
        round: {
          no: N,
          games: [],
          resting: eligible.map(function (p) { return p.id; }),
          locked: false
        },
        cost: 0,
        partnerRepeats: 0
      };
    }

    if (courts <= 0) return emptyRound();
    var need = courts * 4;
    if (eligible.length > DEEP_LOOKAHEAD_MAX_PLAYERS) depth = 0;

    // 선수별 정렬 지표
    var info = {};
    eligible.forEach(function (p) {
      var s = stats[p.id];
      var avail = availableRounds(p, N);
      var wait = consecutiveWait(p, N, playedSets[p.id]);
      info[p.id] = {
        p: p,
        played: s.played,
        rate: s.played / Math.max(1, avail),
        wait: wait,
        // 하드 제약 A: 신규 합류자는 첫 2라운드 연속 출전 금지
        blocked: (N === p.joinedRound + 1) && !!playedSets[p.id][p.joinedRound],
        // 하드 제약 B: 3라운드 연속 대기자는 무조건 우선 배정
        forced: wait >= 3
      };
    });

    // 승수 (2경기 미만 소화 선수는 0으로 간주 — SPEC §2.3)
    function winsOf(id) {
      var s = stats[id];
      return s.scored >= 2 ? s.wins : 0;
    }
    var hist = session.history || { partner: {}, opponent: {} };
    var ctx = {
      partner: function (a, b) { return (hist.partner || {})[pairKey(a, b)] || 0; },
      opponent: function (a, b) { return (hist.opponent || {})[pairKey(a, b)] || 0; },
      wins: winsOf,
      balanceWeight: balanceWeight
    };

    function cmp(a, b) {
      if (Math.abs(a.rate - b.rate) > 1e-9) return a.rate - b.rate;   // 1. 출전율 오름차순
      if (a.wait !== b.wait) return b.wait - a.wait;                  // 2. 연속 대기 내림차순
      return a.played - b.played;                                     // 3. 절대 경기수 오름차순
      // 4. 랜덤 타이브레이크는 아래 enumerateSelections 에서 처리한다
    }

    /**
     * 정렬 규칙을 만족하는 **모든** 선발 조합을 열거한다.
     * 우선순위가 같은 동점 그룹에서 누구를 뽑을지가 곧 랜덤 타이브레이크이므로,
     * 그 그룹의 조합을 전부(많으면 무작위 표본으로) 만들어 낸다.
     */
    function enumerateSelections() {
      var list = eligible.map(function (p) {
        var i = info[p.id];
        return { id: p.id, rate: i.rate, wait: i.wait, played: i.played, blocked: i.blocked, forced: i.forced };
      });
      var forcedB = list.filter(function (x) { return x.forced; }).sort(cmp);
      var normalB = list.filter(function (x) { return !x.forced && !x.blocked; }).sort(cmp);
      var blockedB = list.filter(function (x) { return !x.forced && x.blocked; }).sort(cmp);
      var ordered = forcedB.concat(normalB, blockedB);

      // 버킷 + 우선순위가 완전히 같은 연속 구간 = 동점 그룹
      var bucketOf = {};
      forcedB.forEach(function (x) { bucketOf[x.id] = 0; });
      normalB.forEach(function (x) { bucketOf[x.id] = 1; });
      blockedB.forEach(function (x) { bucketOf[x.id] = 2; });

      var base = [], tie = [], count = 0, i = 0;
      while (i < ordered.length && count < need) {
        var j = i;
        while (j < ordered.length &&
          bucketOf[ordered[j].id] === bucketOf[ordered[i].id] &&
          Math.abs(ordered[j].rate - ordered[i].rate) <= 1e-9 &&
          ordered[j].wait === ordered[i].wait &&
          ordered[j].played === ordered[i].played) j++;
        var group = ordered.slice(i, j);
        if (count + group.length <= need) {
          group.forEach(function (x) { base.push(x.id); });
          count += group.length;
        } else {
          tie = group.map(function (x) { return x.id; });
          break;
        }
        i = j;
      }

      var pickCount = need - base.length;
      if (pickCount <= 0) return [base.slice()];

      var combos = [];
      var total = 1;
      for (var t = 0; t < pickCount; t++) total = total * (tie.length - t) / (t + 1);
      if (total <= MAX_SELECTIONS) {
        (function comb(start, acc) {
          if (acc.length === pickCount) { combos.push(base.concat(acc)); return; }
          for (var k = start; k < tie.length; k++) {
            acc.push(tie[k]);
            comb(k + 1, acc);
            acc.pop();
          }
        })(0, []);
      } else {
        for (var s = 0; s < MAX_SELECTIONS; s++) {
          combos.push(base.concat(shuffleInPlace(tie.slice(), rng).slice(0, pickCount)));
        }
      }
      return shuffleInPlace(combos, rng);
    }

    /** 선발 조합 하나에 대한 배치 후보들 (비용 오름차순) */
    function arrangementsFor(sel) {
      // 예측의 말단(depth 0)에서는 "깨끗한 배치가 있는가"만 알면 되므로
      // 전수 열거 대신 분기한정 탐색 1회로 끝낸다 (탐색 비용 대폭 절감).
      if (sel.length <= FULL_ENUM_MAX && depth > 0) {
        // 필요한 만큼(=이 레벨에서 검토할 후보 수)만 찾으면 열거를 멈춘다.
        var limit = Math.max(3, optionCap - examined + 1);
        var all = enumerateArrangements(shuffleInPlace(sel.slice(), rng), courts, ctx, limit);
        all.sort(function (a, b) { return a.cost - b.cost; });
        return all;
      }
      var b = bestArrangement(shuffleInPlace(sel.slice(), rng), courts, ctx);
      if (!b.games) return [];
      return [{ games: b.games, cost: b.cost, partnerRepeats: partnerRepeatsOfGames(b.games, ctx) }];
    }

    function materialize(sel, gamePairs) {
      var playing = {};
      sel.forEach(function (id) { playing[id] = true; });
      return {
        no: N,
        games: gamePairs.map(function (g, idx) {
          return {
            id: "r" + N + "c" + (idx + 1),
            court: idx + 1,
            teamA: g.A.slice(),
            teamB: g.B.slice(),
            scoreA: null,
            scoreB: null,
            status: "pending"
          };
        }),
        resting: eligible
          .filter(function (p) { return !playing[p.id]; })
          .map(function (p) { return p.id; }),
        locked: false
      };
    }

    var best = null;          // 파트너 중복 0 + 앞 라운드까지 안전
    var bestClean = null;     // 파트너 중복 0 (앞 라운드는 차선)
    var bestCleanPenalty = Infinity;
    var bestAny = null;       // 그 외 최소 비용
    var examined = 0;
    // 깊이가 깊어질수록 후보 폭을 좁힌다 (탐색 폭발 방지)
    var optionCap = Math.max(2, Math.round(MAX_OPTIONS / Math.pow(5, topDepth - depth)));

    var selections = enumerateSelections();
    outer:
    for (var si = 0; si < selections.length; si++) {
      var sel = selections[si];
      var options = arrangementsFor(sel);

      for (var oi = 0; oi < options.length; oi++) {
        var opt = options[oi];
        var cand = { round: null, cost: opt.cost, partnerRepeats: opt.partnerRepeats, sel: sel, games: opt.games };
        if (!bestAny || cand.cost < bestAny.cost) bestAny = cand;
        // 비용 오름차순이므로 파트너 중복이 생기기 시작하면 이 선발은 더 볼 필요 없다
        if (cand.partnerRepeats > 0) break;

        // 파트너·상대 중복이 모두 0 이면 여유가 충분하다는 뜻이라 앞을 볼 필요가 없다
        if (depth <= 0 || budget <= 0 || cand.cost === 0) { best = cand; break outer; }
        if (++examined > optionCap) break outer;

        // 앞 라운드 확인: 이 라운드를 확정해도 다음 라운드들이 파트너 중복 0 인가
        budget--;
        var next = buildRoundInternal(cloneWithRound(session, materialize(sel, opt.games)), rng, depth - 1);
        if (next.partnerRepeats === 0 && !next.deadEnd) { best = cand; break outer; }

        // 완벽하지 않다면 "가장 덜 나쁜" 후보를 기억해 둔다
        var penalty = next.partnerRepeats * 10 + (next.deadEnd ? 1 : 0) + cand.cost / 1000;
        if (penalty < bestCleanPenalty) { bestCleanPenalty = penalty; bestClean = cand; }
      }
    }

    var chosen = best || bestClean || bestAny;
    if (chosen && !chosen.round) chosen.round = materialize(chosen.sel, chosen.games);
    if (!chosen) return emptyRound();
    // deadEnd = 파트너 중복 0 + 앞 라운드까지 안전한 후보를 찾지 못하고 타협했다는 표시
    chosen.deadEnd = !best;
    return chosen;
  }

  /* ══════════════════════════════════════════════
     라운드 확정 — session 을 직접 변경한다
     ══════════════════════════════════════════════ */

  /**
   * commitRound(session, round)
   *  · session.rounds 에 round 를 push
   *  · session.history.partner / .opponent 를 증분 갱신 (키는 정렬된 "pA|pB")
   *  · **session 을 mutate** 하고 같은 session 을 반환한다.
   */
  function commitRound(session, round) {
    if (!session.rounds) session.rounds = [];
    if (!session.history) session.history = { partner: {}, opponent: {} };
    if (!session.history.partner) session.history.partner = {};
    if (!session.history.opponent) session.history.opponent = {};

    var P = session.history.partner, O = session.history.opponent;
    (round.games || []).forEach(function (g) {
      var a = g.teamA, b = g.teamB;
      var ka = pairKey(a[0], a[1]), kb = pairKey(b[0], b[1]);
      P[ka] = (P[ka] || 0) + 1;
      P[kb] = (P[kb] || 0) + 1;
      for (var i = 0; i < 2; i++) for (var j = 0; j < 2; j++) {
        var ko = pairKey(a[i], b[j]);
        O[ko] = (O[ko] || 0) + 1;
      }
    });
    session.rounds.push(round);
    return session;
  }

  /**
   * rebuildHistory(session)
   *  · session.rounds 전체를 훑어 history.partner / .opponent 를 처음부터 다시 만든다.
   *  · 선수 교체(스왑)나 미확정 라운드 재생성처럼 라운드가 사후 변경된 뒤 호출한다.
   *  · **session 을 mutate** 하고 같은 session 을 반환한다.
   */
  function rebuildHistory(session) {
    var P = {}, O = {};
    (session.rounds || []).forEach(function (r) {
      (r.games || []).forEach(function (g) {
        var a = g.teamA, b = g.teamB;
        if (!a || !b) return;
        var ka = pairKey(a[0], a[1]), kb = pairKey(b[0], b[1]);
        P[ka] = (P[ka] || 0) + 1;
        P[kb] = (P[kb] || 0) + 1;
        for (var i = 0; i < 2; i++) for (var j = 0; j < 2; j++) {
          var ko = pairKey(a[i], b[j]);
          O[ko] = (O[ko] || 0) + 1;
        }
      });
    });
    session.history = { partner: P, opponent: O };
    return session;
  }

  /* ══════════════════════════════════════════════
     세션 생성 헬퍼 (테스트/UI 편의용)
     ══════════════════════════════════════════════ */

  function createSession(opts) {
    opts = opts || {};
    return {
      version: 2,
      id: opts.id || "session",
      date: opts.date || "2026-08-10",
      config: {
        courts: opts.courts == null ? 1 : opts.courts,
        winPoint: opts.winPoint == null ? 11 : opts.winPoint,
        winBy2: opts.winBy2 !== false,
        balanceWeight: opts.balanceWeight || 0
      },
      players: (opts.players || []).map(function (p, i) {
        if (typeof p === "string") {
          return { id: "p" + (i + 1), name: p, joinedRound: 1, leftRound: null, active: true };
        }
        return {
          id: p.id || ("p" + (i + 1)),
          name: p.name,
          joinedRound: p.joinedRound || 1,
          leftRound: p.leftRound == null ? null : p.leftRound,
          active: p.active !== false
        };
      }),
      rounds: [],
      history: { partner: {}, opponent: {} }
    };
  }

  return {
    buildRound: buildRound,
    commitRound: commitRound,
    rebuildHistory: rebuildHistory,
    applyResult: commitRound,
    rankPlayers: rankPlayers,
    playerStats: playerStats,
    validateScore: validateScore,
    availableRounds: availableRounds,
    isEligible: isEligible,
    pairKey: pairKey,
    rankCompare: rankCompare,
    createSession: createSession
  };
});
