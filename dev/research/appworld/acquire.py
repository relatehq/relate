"""Read-only, explicit compositions of public application APIs."""

import json


def pages(api, **kwargs):
    records = []
    for page_index in range(100):
        page = api(**kwargs, page_index=page_index, page_limit=20)
        if not isinstance(page, list):
            raise ValueError("Collection API did not return a list")
        records.extend(page)
        if not page:
            return records
    raise ValueError("Acquisition cap reached; cannot claim complete collection")


def payments(apis, phone_token, venmo_token):
    contacts = pages(apis.phone.search_contacts, access_token=phone_token)
    transactions = pages(apis.venmo.show_transactions, access_token=venmo_token)
    people = {}
    for transaction in transactions:
        for direction in ["sender", "receiver"]:
            person = transaction[direction]
            people[person["email"]] = {
                "sourceId": person["email"],
                "name": person["name"],
                "relationshipsJson": "[]",
            }
    for person in contacts:
        email = person["email"]
        if not email:
            continue
        if email in people and people[email]["relationshipsJson"] != "[]":
            raise ValueError("Ambiguous duplicate contact identity")
        people[email] = {
            "sourceId": email,
            "name": f"{person['first_name']} {person['last_name']}",
            "relationshipsJson": json.dumps(person["relationships"]),
        }
    return {
        "Person": list(people.values()),
        "Transaction": [
            {
                "sourceId": str(t["transaction_id"]),
                "sender": t["sender"]["email"],
                "receiver": t["receiver"]["email"],
                "amount": t["amount"],
                "description": t["description"],
                "createdAt": t["created_at"],
                "likeCount": t["like_count"],
            }
            for t in transactions
        ],
    }
