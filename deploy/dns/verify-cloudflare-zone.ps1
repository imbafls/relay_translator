# Diff the zone Cloudflare will serve against the Hostinger inventory,
# BEFORE the nameservers are switched. Queries Cloudflare's assigned
# nameserver directly, so it tests what will actually be answered rather
# than what is currently live.
#
#   powershell -File deploy/dns/verify-cloudflare-zone.ps1
#
# Every expectation here comes from deploy/dns/supr.systems-before-migration.md.

param([string]$NS = "craig.ns.cloudflare.com")
# $NS = a specific nameserver to interrogate, or a public resolver like 8.8.8.8
# to check what the world actually sees after a cutover.
$Domain = "supr.systems"
$fail = 0
$pass = 0

function Check($label, $type, $name, $expected) {
    # PowerShell does not interpolate a variable inside a native command
    # argument like -type=$type; it passes the literal text and nslookup
    # answers with a default A lookup, which reads as "everything is missing".
    $typeArg = "-type=" + $type
    $out = (nslookup $typeArg $name $script:NS 2>&1 | Out-String)
    $ok = $true
    foreach ($e in $expected) {
        if ($out -notmatch [regex]::Escape($e)) { $ok = $false; break }
    }
    if ($ok) {
        Write-Host ("PASS  {0}" -f $label)
        $script:pass++
    } else {
        Write-Host ("FAIL  {0}" -f $label) -ForegroundColor Red
        Write-Host ("      wanted: {0}" -f ($expected -join " | "))
        Write-Host ("      got   : {0}" -f (($out -split "`n" | Where-Object { $_ -match '\S' }) -join " / "))
        $script:fail++
    }
}

Write-Host "Querying $NS for $Domain`n"

# --- the website ---------------------------------------------------------
Check "A     apex -> Vercel"            "A"     $Domain                              @("76.76.21.21")
Check "CNAME www -> Vercel"             "CNAME" "www.$Domain"                        @("cname.vercel-dns.com")

# --- inbound mail: losing these bounces mail -----------------------------
Check "MX    apex -> mx1 (pri 5)"       "MX"    $Domain                              @("mx1.hostinger.com")
Check "MX    apex -> mx2 (pri 10)"      "MX"    $Domain                              @("mx2.hostinger.com")
Check "MX    send -> SES bounces"       "MX"    "send.$Domain"                       @("feedback-smtp.us-east-1.amazonses.com")

# --- outbound authentication: losing these means silent spam foldering ---
Check "TXT   apex SPF"                  "TXT"   $Domain                              @("v=spf1", "_spf.mail.hostinger.com")
Check "TXT   send SPF"                  "TXT"   "send.$Domain"                       @("v=spf1", "amazonses.com")
Check "TXT   DMARC"                     "TXT"   "_dmarc.$Domain"                     @("v=DMARC1")
Check "TXT   Resend DKIM"               "TXT"   "resend._domainkey.$Domain"          @("p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCroXEbwvOMBRKBhKVYBXBuuB22q1VdhpcjPJZFYi46Sf7ZzIQOF")
Check "CNAME Hostinger DKIM a"          "CNAME" "hostingermail-a._domainkey.$Domain" @("hostingermail-a.dkim.mail.hostinger.com")
Check "CNAME Hostinger DKIM b"          "CNAME" "hostingermail-b._domainkey.$Domain" @("hostingermail-b.dkim.mail.hostinger.com")
Check "CNAME Hostinger DKIM c"          "CNAME" "hostingermail-c._domainkey.$Domain" @("hostingermail-c.dkim.mail.hostinger.com")

# --- mail client setup ----------------------------------------------------
Check "CNAME autoconfig"                "CNAME" "autoconfig.$Domain"                 @("autoconfig.mail.hostinger.com")
Check "CNAME autodiscover"              "CNAME" "autodiscover.$Domain"               @("autodiscover.mail.hostinger.com")

Write-Host ""
Write-Host ("{0} passed, {1} failed" -f $pass, $fail)

# `relay` is deliberately NOT recreated: the VPS is retired and the name is
# wanted for the Worker custom domain. Reported, not asserted.
$relay = (nslookup -type=A "relay.$Domain" $NS 2>&1 | Out-String)
if ($relay -match "76\.76|187\.124") {
    Write-Host "NOTE  relay.$Domain still resolves on Cloudflare - expected it to be absent"
} else {
    Write-Host "NOTE  relay.$Domain is absent on Cloudflare, as intended (Worker custom domain will claim it)"
}

if ($fail -gt 0) { exit 1 }
