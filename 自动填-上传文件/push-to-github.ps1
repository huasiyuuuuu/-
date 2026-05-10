param(
  [string]$RepoUrl = ""
)

$ErrorActionPreference = "Stop"

if (-not $RepoUrl) {
  $RepoUrl = Read-Host "Paste the empty GitHub repository HTTPS URL"
}

if (-not $RepoUrl) {
  throw "Repository URL is required."
}

git rev-parse --is-inside-work-tree | Out-Null
git branch -M main

$changes = git status --porcelain
if ($changes) {
  git add -A
  git commit -m "Update extension"
}

$existingRemote = ""
try {
  $existingRemote = git remote get-url origin
} catch {
  $existingRemote = ""
}

if ($existingRemote) {
  git remote set-url origin $RepoUrl
} else {
  git remote add origin $RepoUrl
}

git push -u origin main
