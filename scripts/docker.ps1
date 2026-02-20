param(
  [Parameter(Position=0)]
  [string]$Command = "help",

  [Parameter(ValueFromRemainingArguments=$true)]
  [string[]]$Args
)

$ErrorActionPreference = 'Stop'

function Run($cmd) {
  Write-Host "> $cmd" -ForegroundColor DarkGray
  cmd.exe /c $cmd
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

switch ($Command.ToLowerInvariant()) {
  'help' {
    @(
      "Kimberly Docker helpers (Windows)",
      "",
      "Usage:",
      "  .\\scripts\\docker.ps1 <command> [args]",
      "",
      "Core:",
      "  up                 -> docker compose up -d",
      "  down               -> docker compose down",
      "  ps                 -> docker compose ps",
      "  logs               -> docker compose logs -f --tail=200",
      "",
      "Wizard / runs:",
      "  setup              -> docker compose run --rm crawler-setup",
      "  cli                -> docker compose run --rm crawler-cli",
      "  monitor            -> docker compose run --rm crawler-monitor",
      "  debrid             -> docker compose run --rm crawler-cli node src/bin/debrid-cli.js",
      "  debrid-url <url>   -> run debrid-cli.js with a Letterboxd URL",
      "",
      "Cron scripts (inside docker):",
      "  cron-linux         -> docker compose run --rm crawler-cli npm run cron:linux",
      "  cron-windows       -> docker compose run --rm crawler-cli npm run cron:windows"
    ) | ForEach-Object { Write-Host $_ }
    break
  }

  'up' { Run "docker compose up -d"; break }
  'down' { Run "docker compose down"; break }
  'ps' { Run "docker compose ps"; break }
  'logs' { Run "docker compose logs -f --tail=200"; break }

  'setup' { Run "docker compose run --rm crawler-setup"; break }
  'cli' { Run "docker compose run --rm crawler-cli"; break }
  'monitor' { Run "docker compose run --rm crawler-monitor"; break }

  'debrid' { Run "docker compose run --rm crawler-cli node src/bin/debrid-cli.js"; break }
  'debrid-url' {
    if (-not $Args -or $Args.Count -lt 1 -or [string]::IsNullOrWhiteSpace($Args[0])) {
      Write-Host "Missing URL. Example: .\\scripts\\docker.ps1 debrid-url https://boxd.it/xxxx" -ForegroundColor Yellow
      exit 2
    }
    $url = $Args[0]
    Run "docker compose run --rm crawler-cli node src/bin/debrid-cli.js \"$url\""
    break
  }

  'cron-linux' { Run "docker compose run --rm crawler-cli npm run cron:linux"; break }
  'cron-windows' { Run "docker compose run --rm crawler-cli npm run cron:windows"; break }

  default {
    Write-Host "Unknown command: $Command" -ForegroundColor Yellow
    Run ".\\scripts\\docker.ps1 help"
    exit 2
  }
}
