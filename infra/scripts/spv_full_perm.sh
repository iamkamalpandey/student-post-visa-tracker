#!/usr/bin/env bash
# Full permission + CRUD smoke across ADMIN, COUNSELLOR, VIEWER roles.
# Hits the running backend at http://localhost:4000.
set -u
B=http://localhost:4000/api/v1
fail=0; pass=0
say() { printf "%-72s %s\n" "$1" "$2"; }
ok()  { pass=$((pass+1)); say "$1" "OK"; }
bad() { fail=$((fail+1)); say "$1" "FAIL: $2"; }

j() {
  # extract a JSON path via node; usage: echo "$json" | j 'access_token'
  node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{ try { const r=JSON.parse(d); console.log(eval("r."+process.argv[1])) } catch(e) { console.log("") } })' "$1"
}
code() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

# ---------- bootstrap admin token ----------
ALOG=$(curl -sS -X POST "$B/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"ChangeMeNow!2026"}')
ATOKEN=$(echo "$ALOG" | j 'access_token')
[ -n "$ATOKEN" ] && ok "admin login" || { bad "admin login" "$ALOG"; exit 1; }
A="Authorization: Bearer $ATOKEN"

# ---------- create COUNSELLOR + VIEWER (idempotent — ignore conflicts) ----------
curl -sS -X POST "$B/users" -H "$A" -H 'Content-Type: application/json' \
  -d '{"email":"counsellor.perm@example.com","password":"Counsel-Pass-2026!","given_name":"Carla","family_name":"Counsellor","role":"COUNSELLOR"}' >/dev/null
curl -sS -X POST "$B/users" -H "$A" -H 'Content-Type: application/json' \
  -d '{"email":"viewer.perm@example.com","password":"Viewer-Pass-2026!","given_name":"Vince","family_name":"Viewer","role":"VIEWER"}' >/dev/null

CLOG=$(curl -sS -X POST "$B/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"counsellor.perm@example.com","password":"Counsel-Pass-2026!"}')
CTOKEN=$(echo "$CLOG" | j 'access_token')
[ -n "$CTOKEN" ] && ok "counsellor login" || bad "counsellor login" "$CLOG"
C="Authorization: Bearer $CTOKEN"

VLOG=$(curl -sS -X POST "$B/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"viewer.perm@example.com","password":"Viewer-Pass-2026!"}')
VTOKEN=$(echo "$VLOG" | j 'access_token')
[ -n "$VTOKEN" ] && ok "viewer login" || bad "viewer login" "$VLOG"
V="Authorization: Bearer $VTOKEN"

# ---------- READ access ----------
for R in admin counsellor viewer; do
  case $R in admin) H="$A";; counsellor) H="$C";; viewer) H="$V";; esac
  for RES in stages lookups/countries lookups/document-types dashboard/summary; do
    rc=$(code "$B/$RES" -H "$H")
    [ "$rc" = "200" ] && ok "$R GET /$RES" || bad "$R GET /$RES" "$rc"
  done
done

# ---------- WRITE matrix ----------
INITIAL=$(curl -sS "$B/stages" -H "$A" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{ try { const r=JSON.parse(d); const a=Array.isArray(r)?r:(r.data||[]); console.log((a.find(s=>s.is_initial)||{}).id||"") } catch(e){} })')
NEXT_STAGE=$(curl -sS "$B/stages" -H "$A" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{ try { const r=JSON.parse(d); const a=Array.isArray(r)?r:(r.data||[]); console.log((a.find(s=>s.sequence===2)||{}).id||"") } catch(e){} })')

ADMIN_ST=$(code -X POST "$B/stages" -H "$A" -H 'Content-Type: application/json' \
  -d '{"key":"perm_test_'"$RANDOM"'","label":"Perm Test","sequence":99,"category":"PRE_DEPARTURE"}')
[ "$ADMIN_ST" = "200" ] || [ "$ADMIN_ST" = "201" ] && ok "ADMIN POST /stages ($ADMIN_ST)" || bad "ADMIN stage" "$ADMIN_ST"

COUN_ST=$(code -X POST "$B/stages" -H "$C" -H 'Content-Type: application/json' \
  -d '{"key":"x","label":"X","sequence":100,"category":"PRE_DEPARTURE"}')
[ "$COUN_ST" = "403" ] && ok "COUNSELLOR POST /stages denied" || bad "counsellor stage" "$COUN_ST"

VIEW_ST=$(code -X POST "$B/stages" -H "$V" -H 'Content-Type: application/json' \
  -d '{"key":"y","label":"Y","sequence":101,"category":"PRE_DEPARTURE"}')
[ "$VIEW_ST" = "403" ] && ok "VIEWER POST /stages denied" || bad "viewer stage" "$VIEW_ST"

COUN_U=$(code -X POST "$B/users" -H "$C" -H 'Content-Type: application/json' \
  -d '{"email":"x@e.co","password":"abcdefghij12","given_name":"X","family_name":"Y"}')
[ "$COUN_U" = "403" ] && ok "COUNSELLOR POST /users denied" || bad "counsellor user" "$COUN_U"
VIEW_U=$(code -X POST "$B/users" -H "$V" -H 'Content-Type: application/json' \
  -d '{"email":"x2@e.co","password":"abcdefghij12","given_name":"X","family_name":"Y"}')
[ "$VIEW_U" = "403" ] && ok "VIEWER POST /users denied" || bad "viewer user" "$VIEW_U"

# Student create + RBAC
STUDENT_BODY=$(printf '{"given_name":"Maya","family_name":"KC","name_in_passport":"MAYA KC","date_of_birth":"2003-01-15","gender":"FEMALE","nationality_code":"NP","primary_language":"en","email_primary":"maya.%s@example.com","phone_primary_e164":"+9779800000001","current_stage_id":"%s"}' "$RANDOM" "$INITIAL")
SC=$(curl -sS -X POST "$B/students" -H "$C" -H 'Content-Type: application/json' -d "$STUDENT_BODY")
SID=$(echo "$SC" | j 'id||(r.data&&r.data.id)||""')
[ -n "$SID" ] && ok "COUNSELLOR created student" || bad "counsellor create student" "$SC"

VS=$(code -X POST "$B/students" -H "$V" -H 'Content-Type: application/json' -d "$STUDENT_BODY")
[ "$VS" = "403" ] && ok "VIEWER POST /students denied" || bad "viewer create student" "$VS"

RV=$(code "$B/students/$SID" -H "$V")
[ "$RV" = "200" ] && ok "VIEWER GET student" || bad "viewer read student" "$RV"

CD=$(code -X DELETE "$B/students/$SID" -H "$C")
[ "$CD" = "403" ] && ok "COUNSELLOR DELETE student denied" || bad "counsellor delete" "$CD"

VD=$(code -X DELETE "$B/students/$SID" -H "$V")
[ "$VD" = "403" ] && ok "VIEWER DELETE student denied" || bad "viewer delete" "$VD"

# Lifecycle transition
TR_BODY=$(printf '{"to_stage_id":"%s","effective_at":"2026-05-14T10:00:00.000Z","notes":"moved by counsellor"}' "$NEXT_STAGE")
TR=$(curl -sS -X POST "$B/students/$SID/transitions" -H "$C" -H 'Content-Type: application/json' -d "$TR_BODY")
echo "$TR" | grep -q '"to_stage_id"' && ok "COUNSELLOR transitioned stage" || bad "transition" "$TR"

TL_N=$(curl -sS "$B/students/$SID/timeline" -H "$C" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{ try { const r=JSON.parse(d); const a=Array.isArray(r)?r:(r.data||[]); console.log(a.length) } catch(e){console.log(0)} })')
[ "$TL_N" -ge 1 ] && ok "timeline has $TL_N event(s)" || bad "timeline empty" "$TL_N"

# Nested sub-resource
QB='{"level":"BACHELORS","institution":"Tribhuvan University","country_code":"NP","field_of_study":"Computer Science","grade_value":"3.6","grade_scale":"GPA-4","is_highest":true}'
QC=$(curl -sS -X POST "$B/students/$SID/qualifications" -H "$C" -H 'Content-Type: application/json' -d "$QB")
echo "$QC" | grep -qE '"id"|"institution"' && ok "COUNSELLOR added qualification" || bad "qualification" "$QC"

VQ=$(code -X POST "$B/students/$SID/qualifications" -H "$V" -H 'Content-Type: application/json' -d "$QB")
[ "$VQ" = "403" ] && ok "VIEWER POST qualification denied" || bad "viewer qual" "$VQ"

LIST=$(curl -sS "$B/students?limit=10" -H "$A")
echo "$LIST" | grep -qE '"data"|"page"' && ok "students list shape" || bad "list" "first200=${LIST:0:200}"

# Patch role
CUSER_ID=$(echo "$CLOG" | j 'user.id')
PR=$(curl -sS -X PATCH "$B/users/$CUSER_ID" -H "$A" -H 'Content-Type: application/json' -d '{"role":"VIEWER"}')
echo "$PR" | grep -q '"role":"VIEWER"' && ok "ADMIN patched user role" || bad "patch role" "$PR"

# Final delete + verify
DEL=$(code -X DELETE "$B/students/$SID" -H "$A")
{ [ "$DEL" = "204" ] || [ "$DEL" = "200" ]; } && ok "ADMIN deleted student ($DEL)" || bad "admin delete" "$DEL"

GA=$(code "$B/students/$SID" -H "$A")
[ "$GA" = "404" ] && ok "deleted student returns 404" || bad "post-delete" "$GA"

UA=$(code "$B/students")
[ "$UA" = "401" ] && ok "no token → 401" || bad "unauth" "$UA"

BT=$(code "$B/students" -H "Authorization: Bearer not.a.real.token")
[ "$BT" = "401" ] && ok "bad token → 401" || bad "bad token" "$BT"

# Restore counsellor role for browser testing
curl -sS -X PATCH "$B/users/$CUSER_ID" -H "$A" -H 'Content-Type: application/json' -d '{"role":"COUNSELLOR"}' >/dev/null

echo
echo "PASS=$pass FAIL=$fail"
exit $fail
