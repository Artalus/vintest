#!/bin/bash

set -exuo pipefail

dotnet build VinTest/VinTest.csproj --configuration Release
dotnet build VinTest.Cake/VinTest.Cake.csproj --configuration Release
uv run docs.py --target vintage
rm -rf docs/api/
mkdir docs/api/
ln docs/api.md docs/api/index.md
uv run docs.py --target core
mv dedo-out/* docs/api/
uv run docs.py --target cake
mv dedo-out/* docs/api/
uv run zensical build --clean
