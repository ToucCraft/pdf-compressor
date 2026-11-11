PORT ?= 8080
HOST ?= 0.0.0.0
VENV := .venv
PYTHON := $(VENV)/bin/python3
PIP := $(VENV)/bin/pip
STAMP := $(VENV)/.installed

.PHONY: up install run clean docker-up

up: $(STAMP)
	@echo "===================================================="
	@echo "Starting PDF Compressor Pro on http://localhost:$(PORT)"
	@echo "===================================================="
	$(PYTHON) -m uvicorn app:app --host $(HOST) --port $(PORT) --reload

install: $(STAMP)

$(STAMP): requirements.txt
	@if [ ! -d "$(VENV)" ]; then \
		echo "Creating virtual environment..."; \
		python3 -m venv $(VENV); \
	fi
	@echo "Installing dependencies..."
	@$(PIP) install --upgrade pip
	@$(PIP) install -r requirements.txt
	@touch $(STAMP)

clean:
	rm -rf $(VENV) __pycache__ /tmp/pdf_compressor_*

docker-up:
	docker compose up --build
