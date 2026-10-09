SHELL := /bin/bash

.DEFAULT_GOAL := help

export LOCAL_IP
export DEVELOPER_DIR ?= /Applications/Xcode.app/Contents/Developer

.PHONY: help mobile mobile-build mobile-ios mobile-setup mobile-ip mobile-down

help:
	@echo "UCBarkley local mobile commands"
	@echo
	@echo "  make mobile        Start DB, API, AI, worker, and Expo Metro"
	@echo "  make mobile-build  Build/install the iOS development app and start everything"
	@echo "  make mobile-setup  Install JavaScript and Python dependencies"
	@echo "  make mobile-ip     Show the LAN IP and API URL that will be used"
	@echo "  make mobile-down   Stop local Postgres and MinIO"
	@echo
	@echo "Optional override when automatic IP detection is wrong:"
	@echo "  make mobile LOCAL_IP=192.168.1.25"

mobile:
	@./scripts/mobile-local.sh dev

mobile-build mobile-ios:
	@./scripts/mobile-local.sh ios

mobile-setup:
	@./scripts/mobile-local.sh setup

mobile-ip:
	@./scripts/mobile-local.sh ip

mobile-down:
	@docker compose stop postgres minio
